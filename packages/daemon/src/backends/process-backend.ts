import { spawn } from "node:child_process";
import { quotaBlock, type Observation } from "./quota.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRequest, BackendResult } from "./types.js";

/**
 * How long a dead child's pipes get to close before we settle anyway — B200.
 *
 * `exit` says the process is gone; `close` says nothing still holds its
 * streams. Normally they are microseconds apart and `close` wins, delivering
 * every byte. This timer only ever runs out when a helper the CLI spawned
 * inherited stdout and outlived it — and then waiting longer changes nothing
 * except how long the slot stays held.
 *
 * Two seconds: long enough that no ordinary flush loses a byte, short enough
 * that a job whose answer is already complete is not sitting on a device.
 *
 * **The value is not demonstrably necessary and is kept anyway — measured.**
 * Setting it to zero passes every case in
 * `a-helper-cannot-hold-a-job-open.test.ts`, because on this machine `close`
 * always wins the race and `finish` is idempotent. What the margin buys is the
 * case that race can lose: a large answer still draining when the process
 * exits. **That failure would be silent truncation** — a shorter answer, no
 * error, nothing to notice — and a margin against a silent failure is worth
 * two seconds on a path that only runs when a job has already ended.
 *
 * Said out loud rather than implied, because a constant whose test cannot fail
 * is exactly the kind that gets tuned to zero by somebody reading the green.
 */
const PIPE_GRACE_MS = 2_000;

/**
 * The spawn every process-class backend runs — byollm_004 §2, in one place.
 *
 * This was `ClaudeCliBackend.#spawn`, and it was the only one there could be
 * while `claude-cli` was the only process backend. `codex-cli` made that
 * false, and the choice was to copy two hundred lines of security-critical
 * machinery or to share them. Copying is how two implementations of one rule
 * drift, and the rules here are the ones with teeth: an empty scratch cwd, a
 * stripped environment, exactly three std streams, no shell, a hard timeout
 * with SIGTERM→SIGKILL escalation, and an output ceiling enforced while bytes
 * arrive rather than after.
 *
 * What is **not** shared is the argv. An argv is the whole of what a process
 * backend is — which binary, in what mode, with which capabilities switched
 * off — so each backend supplies its own, frozen, and this function passes it
 * through untouched. That is what keeps the adversarial suite's argv
 * assertions meaningful: it can substitute a probe for the binary and prove
 * that a hostile payload produced exactly the argv the backend declared.
 */
export interface ProcessJob {
  /** What to execute, plus anything that must precede the CLI's own argv. */
  readonly launch: {
    readonly command: string;
    readonly prefixArgs: readonly string[];
  };
  /** The backend's own frozen argv. Never built from a payload. */
  readonly argv: readonly string[];
  /** Environment the child may see — already an allowlist. */
  readonly env: NodeJS.ProcessEnv;
  /** How to name this CLI in a diagnostic, e.g. "the codex CLI". */
  readonly displayName: string;
  readonly request: BackendRequest;
  /** When the caller started timing, so durations cover the whole call. */
  readonly started: number;
  /**
   * The clock the quota corpus reads, injectable — S1's shape, one adapter
   * over.
   *
   * A "try again at" already past is dropped, because a stale clock brings
   * somebody back to a machine that is still blocked. Read from `Date.now()`
   * inside, any transcript we hold stops exercising that path the day after
   * it was captured — a test that goes green on a schedule, which is what the
   * Codex adapter was filed for.
   */
  readonly now?: () => number;
  /** The observations to classify against. Tests own their own strings. */
  readonly corpus?: readonly Observation[];
}

export async function runProcessJob(job: ProcessJob): Promise<BackendResult> {
  // A call with no time limit is a caller bug, and running it unbounded is a
  // worse answer than refusing it. Guarded here rather than trusted to the
  // type: the message this replaces read "did not answer within undefinedms",
  // which names a number nobody set — and it fired instantly, so the run
  // looked like a timeout that had not happened.
  if (!Number.isFinite(job.request.timeoutMs) || job.request.timeoutMs <= 0) {
    return {
      ok: false,
      code: "backend-error",
      message: "no time limit was set for this call",
      durationMs: 0,
    };
  }

  // An empty directory of our own making. The child's `cwd` is never the
  // daemon's, never the user's home, and never anything a payload named.
  const scratch = await mkdtemp(join(tmpdir(), "byollm-job-"));
  try {
    return await spawnIn(job, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function spawnIn(job: ProcessJob, scratch: string): Promise<BackendResult> {
  const { request, started, displayName } = job;
  return new Promise<BackendResult>((resolve) => {
    // Check before spawning, not only via the listener below: a job cancelled
    // between the claim and this line arrives with its signal already
    // aborted, and `addEventListener("abort")` never fires for a signal that
    // has already fired. Without this the child would spawn and run to
    // completion after the owner had already said stop.
    if (request.signal.aborted) {
      resolve({
        ok: false,
        code: "canceled",
        message: "the job was canceled before it started",
        durationMs: Date.now() - started,
      });
      return;
    }

    const child = spawn(
      job.launch.command,
      [...job.launch.prefixArgs, ...job.argv],
      {
        cwd: scratch,
        env: job.env,
        // Exactly the three std streams. Nothing else is inherited, so the
        // child cannot reach a descriptor the daemon happens to hold open.
        stdio: ["pipe", "pipe", "pipe"],
        // No shell, ever. With `shell: false` the argv array is passed to
        // execvp verbatim and metacharacters in it are just bytes.
        shell: false,
        /**
         * Its own process group, so helpers die with it — B200.
         *
         * `child.kill()` signals the DIRECT child only. An agentic CLI that
         * spawns a helper left that helper running after SIGTERM, and the
         * helper inherited stdout — so `close` never fired, the promise never
         * settled, and the job held its slot for ever. Todd watched two sit at
         * 20+ minutes under a 600s ceiling.
         *
         * POSIX only. On Windows `detached` means a new console rather than a
         * process group, and negative pids are not a thing — that platform
         * keeps exactly the behaviour it had, which is the honest position
         * until somebody can test a fix there.
         */
        detached: process.platform !== "win32",
      },
    );

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    /**
     * The two boundaries a parent can see — B195.
     *
     * `spawn` fires when the process exists; the first chunk on either stream
     * is the first sign it has anything to say. Everything between them is the
     * child's own startup plus its first vendor response, and those are not
     * separable from out here — see `BackendTiming`, which says so rather than
     * letting the number imply otherwise.
     *
     * `undefined` rather than 0 until each happens, because a call that died
     * before spawning has no spawn time and a zero would be a measurement
     * nobody made.
     */
    let spawnedAt: number | undefined;
    let firstOutputAt: number | undefined;
    const timing = (): { spawnMs?: number; firstOutputMs?: number } => ({
      ...(spawnedAt === undefined ? {} : { spawnMs: spawnedAt - started }),
      ...(firstOutputAt === undefined
        ? {}
        : { firstOutputMs: firstOutputAt - started }),
    });
    const sawOutput = (): void => {
      firstOutputAt ??= Date.now();
    };
    child.on("spawn", () => {
      spawnedAt = Date.now();
    });
    let settled = false;
    let exited = false;
    let reason: "timeout" | "canceled" | "output-too-large" | null = null;

    const finish = (result: BackendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      /* Attached here rather than at each `finish(...)` call — B195. There are
         six of them across timeout, cancel, output-ceiling, spawn error and
         two close paths, and a timing added to five of six is a gap nobody
         would see: the missing one is whichever failure somebody is trying to
         explain. */
      resolve({ ...result, timing: timing() });
    };

    /**
     * Signal the whole group where that is possible — B200.
     *
     * `process.kill(-pid)` addresses the group the `detached` spawn created,
     * which is the only way a helper the CLI started ever hears anything.
     * Falls back to the direct child on Windows, on a child with no pid, and
     * on ESRCH — a group that is already gone is not an error worth throwing
     * out of a kill path whose entire job is to stop waiting.
     */
    const signal = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined || process.platform === "win32") {
        child.kill(sig);
        return;
      }
      try {
        process.kill(-pid, sig);
      } catch {
        child.kill(sig);
      }
    };

    const kill = (why: typeof reason): void => {
      reason = why;
      // SIGTERM first, SIGKILL shortly after: a wedged child must not be able
      // to outlive its budget by ignoring the polite signal.
      //
      // The escalation is gated on `exited`, which we set from the `close`
      // event, and NOT on `child.killed` — that flag means "a signal was
      // sent", not "the process died", so gating on it would mean the SIGKILL
      // never fires against exactly the child that ignores SIGTERM.
      signal("SIGTERM");
      setTimeout(() => {
        if (!exited) signal("SIGKILL");
      }, 2_000).unref();
    };

    const timer = setTimeout(() => {
      kill("timeout");
    }, request.timeoutMs);

    const onAbort = (): void => {
      kill("canceled");
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      sawOutput();
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes) {
        kill("output-too-large");
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      sawOutput();
      // Bounded independently: a chatty stderr must not exhaust memory
      // either, and it is only ever used for a diagnostic message.
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: Error) => {
      finish({
        ok: false,
        code: "backend-unreachable",
        message: `could not start ${displayName}: ${error.message}`,
        durationMs: Date.now() - started,
      });
    });

    /**
     * Settle from a finished child — B200.
     *
     * Extracted because it now has two callers. It ran only from `close`, and
     * **Node fires `close` when the process has exited AND every stdio stream
     * has closed** — a pipe a grandchild inherited keeps it from ever firing.
     * The promise then pends for ever: no outcome, no release, and a slot held
     * by a job that is already dead.
     */
    const settleFrom = (code: number | null): void => {
      const durationMs = Date.now() - started;

      if (reason === "canceled") {
        finish({
          ok: false,
          code: "canceled",
          message: "the job was canceled",
          durationMs,
        });
        return;
      }
      if (reason === "timeout") {
        finish({
          ok: false,
          code: "timeout",
          message: `the model did not answer within ${String(request.timeoutMs)}ms`,
          durationMs,
        });
        return;
      }
      if (reason === "output-too-large") {
        finish({
          ok: false,
          code: "output-too-large",
          message: `the model produced more than ${String(request.maxOutputBytes)} bytes`,
          durationMs,
        });
        return;
      }
      if (code !== 0) {
        // An agentic CLI that cannot authenticate exits non-zero and says so
        // in prose. Recognising that turns a generic `backend-error` into the
        // one typed failure the runner can act on — see {@link isAuthFailure}.
        const said = `${stdout}\n${stderr}`;
        /*
         * Quota before auth — byollm_019 §3.1.
         *
         * Both are prose from the same stream, and the order decides which
         * remedy the owner is given. A quota block needs time and nothing
         * else; being told to sign in when the account is merely busy until
         * 7pm is the remedy-must-match-the-cause failure in a new place.
         *
         * Read here, on this adapter's own definition of failure — a non-zero
         * exit is what "failed" means for a CLI that reports it honestly.
         * Codex does not, which is why its adapter decides for itself from a
         * terminal event and calls the same corpus.
         *
         * The corpus is observed-only, so on every machine that has not met
         * one of these strings this branch is never taken and behaviour is
         * exactly what it was.
         */
        const blocked = quotaBlock(said, (job.now ?? Date.now)(), job.corpus);
        const authFailed = blocked === undefined && isAuthFailure(said);
        finish({
          ok: false,
          code:
            blocked !== undefined
              ? "quota-exhausted"
              : authFailed
                ? "unauthorized"
                : "backend-error",
          ...(blocked?.until === undefined ? {} : { until: blocked.until }),
          message:
            blocked !== undefined
              ? /* The CLI's own words, as the Codex path already carries —
                   M2, 2026-09-04. This said only "out of quota for now",
                   throwing away the sentence that names the time, on the one
                   surface entitled to it. Owner-only: the class is all a site
                   ever sees. */
                `${displayName} is out of quota: ${firstLine(blocked.detail)}`
              : authFailed
                ? `${displayName} is not signed in`
                : stderr.trim() !== ""
                  ? `${displayName} failed: ${firstLine(stderr)}`
                  : /* Nothing on stderr does not mean nothing was said. An
                   agentic CLI writes its errors to stdout — that is where
                   "Failed to authenticate" arrived — and reporting a bare
                   exit code while holding the explanation is the one thing a
                   diagnostic must not do. No new exposure: stdout already
                   goes to the site on success. */
                    stdout.trim() !== ""
                    ? `${displayName} failed: ${firstLine(stdout)}`
                    : `${displayName} exited with status ${String(code)}`,
          durationMs,
        });
        return;
      }
      finish({ ok: true, text: stdout, durationMs });
    };

    /**
     * `exit` fires when the process is gone, whatever still holds its pipes.
     *
     * The grace is what keeps a normal job's output intact: for a child that
     * simply ended, `close` arrives within microseconds of `exit` and settles
     * with everything it said. The timer only ever runs out when something is
     * still holding a stream open — the case this row is about — and then a
     * dead child's answer is whatever it managed to say.
     *
     * `exited` moves here too. The SIGKILL escalation gates on it, and gating
     * on `close` meant the escalation was deciding from a signal that the very
     * failure it exists for prevents.
     */
    child.on("exit", (code) => {
      exited = true;
      setTimeout(() => {
        settleFrom(code);
      }, PIPE_GRACE_MS).unref();
    });

    /* The happy path, unchanged: for a child that simply ended, `close`
       arrives with everything it said and settles before the grace above
       expires. `finish` is idempotent, so whichever wins is the only one that
       counts. */
    child.on("close", (code) => {
      exited = true;
      settleFrom(code);
    });

    // The prompt goes here and nowhere else: on stdin, as bytes, after the
    // argv is already fixed. This is the line byollm_004 §2 is about.
    child.stdin.on("error", () => {
      // A child that died before reading stdin surfaces through `close`.
    });
    child.stdin.end(request.prompt, "utf8");
  });
}

/** First line of stderr, for a one-line diagnostic. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Does this output say "you are not signed in"?
 *
 * A CLI backend that has lost its credentials exits non-zero with prose and
 * no machine-readable code, so this is text matching, which rots. It is worth
 * having anyway because of what it is *for*: the runner withdraws a service on
 * `unauthorized` and does nothing on `backend-error`, so a phrase this misses
 * leaves today's behaviour exactly as it was. The failure mode of the match is
 * silence, not a wrong action — which is the only shape a heuristic like this
 * may take.
 *
 * The corpus is what real CLIs print. Claude says "Not logged in · Please run
 * /login" on stdout and exits 1; that line is why this exists, found when the
 * first cross-user job reached Todd's Mac and the backend reported healthy
 * throughout.
 *
 * Deliberately narrow, and only consulted on a **non-zero exit** — a job that
 * succeeded never reaches it. That bounds the risk without removing it: a run
 * can produce output and then fail for another reason, and the output is a
 * model's answer. So the patterns are word-anchored rather than substrings,
 * and the tests carry the sentences a model might plausibly write.
 */
const AUTH_FAILURE = [
  // Word-anchored, not substrings. `includes("not logged in")` also matches
  // "was not logged into the system", which is a sentence a model can write —
  // and a false positive here withdraws a service that works, which is worse
  // than the silence this replaces.
  /\bnot logged in\b/,
  /\bplease run \/login\b/,
  /\bplease log in\b/,
  /\bnot authenticated\b/,
  /\bauthentication failed\b/,
  /\binvalid api key\b/,
  /\b401 unauthorized\b/,
  /**
   * The expiry family — Todd's Mac, 2026-08-31, and the reason this list grew.
   *
   * The CLI said "Failed to authenticate. API Error: 401 OAuth access token
   * has expired. Re-authenticate to continue." and not one pattern above
   * matched it: the list had "authentication failed" and the CLI wrote the
   * same two words in the other order, and it had "401 unauthorized" against
   * a 401 that named OAuth instead. So a signed-out backend was reported as
   * `backend-error`, the service was not withdrawn, and the sentence that
   * reached the person was "the claude CLI exited with status 1".
   *
   * An expired token is the *common* case in a subscription CLI — it is what
   * happens to everybody eventually, on a machine that was working
   * yesterday — and it was the one the corpus lacked.
   *
   * "failed to authenticate" was in this list for about a minute. The test
   * below refused it: "the guard had failed to authenticate the visitor's
   * papers" is a sentence a model can write, and matching it would withdraw a
   * service that works. The two that remain are auth machinery talking about
   * itself, which prose has little reason to imitate — and Todd's message
   * contained both, so nothing was lost by dropping the loose one.
   */
  /\baccess token has expired\b/,
  /\bre-?authenticate\b/,
];

export function isAuthFailure(output: string): boolean {
  const text = output.toLowerCase();
  return AUTH_FAILURE.some((pattern) => pattern.test(text));
}
