import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRequest, BackendResult } from "./types.js";

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
}

export async function runProcessJob(job: ProcessJob): Promise<BackendResult> {
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
        retryable: false,
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
        detached: false,
      },
    );

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let exited = false;
    let reason: "timeout" | "canceled" | "output-too-large" | null = null;

    const finish = (result: BackendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolve(result);
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
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
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
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes) {
        kill("output-too-large");
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // Bounded independently: a chatty stderr must not exhaust memory
      // either, and it is only ever used for a diagnostic message.
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });

    child.on("error", (error: Error) => {
      finish({
        ok: false,
        code: "backend-unreachable",
        message: `could not start ${displayName}: ${error.message}`,
        retryable: false,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      exited = true;
      const durationMs = Date.now() - started;

      if (reason === "canceled") {
        finish({
          ok: false,
          code: "canceled",
          message: "the job was canceled",
          retryable: false,
          durationMs,
        });
        return;
      }
      if (reason === "timeout") {
        finish({
          ok: false,
          code: "timeout",
          message: `the model did not answer within ${String(request.timeoutMs)}ms`,
          retryable: true,
          durationMs,
        });
        return;
      }
      if (reason === "output-too-large") {
        finish({
          ok: false,
          code: "output-too-large",
          message: `the model produced more than ${String(request.maxOutputBytes)} bytes`,
          retryable: false,
          durationMs,
        });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          code: "backend-error",
          message:
            stderr.trim() === ""
              ? `${displayName} exited with status ${String(code)}`
              : `${displayName} failed: ${firstLine(stderr)}`,
          retryable: false,
          durationMs,
        });
        return;
      }
      finish({ ok: true, text: stdout, durationMs });
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
