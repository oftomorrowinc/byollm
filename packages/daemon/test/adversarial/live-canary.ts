import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { childEnv } from "../../src/backends/index.js";
import { parseCodexOutput } from "../../src/backends/codex-cli.js";
import { isAuthFailure } from "../../src/backends/process-backend.js";
import { quotaBlock } from "../../src/backends/quota.js";

/**
 * What a live canary concluded, and what each conclusion is allowed to do to
 * the run that asked — job 888.
 *
 * The live rows (`file-mentions-stay-outside`, `codex-tools-disabled`) spawn
 * the owner's real CLIs, and a control run that does not leak the canary was
 * one outcome: INCONCLUSIVE, a failure. That is right for a release and wrong
 * for everything else, and it was found the expensive way. Todd and the
 * runner share one codex account; it ran out of quota until Oct 28, and from
 * then every landing of every commit — a README row included — went red on
 * BY-01, as did Todd's own push of the same commit. The canary had not found
 * a hole. It had found a bill.
 *
 * So a control that comes back as **the provider refusing to serve us** is
 * now its own outcome, PROVIDER_UNAVAILABLE, read from the CLI's own output
 * by the classifiers the daemon ships — `parseCodexOutput` for codex, and
 * `quotaBlock` then `isAuthFailure` on a non-zero exit for claude, the order
 * and gating `runProcessJob` uses. Not a second set of patterns typed here:
 * a canary that disagreed with the daemon about what "out of quota" looks
 * like would be skipping, or failing, on a sentence the product reads the
 * other way.
 *
 * What it does depends on who asked:
 *
 * - **`pnpm verify`** (a landing, the pre-push stamp): a SKIP, printed as one
 *   line naming the provider, its words and its clock, and written to
 *   {@link SKIP_MARKER} so `record-verified.mjs` repeats it at the bottom of
 *   the log a lander keeps.
 * - **the release gate** (`BYOLLM_RELEASE_GATE=1`): a FAILURE, exactly as
 *   INCONCLUSIVE is. A release must not ship with the canary unrun, and
 *   "unrun because the bill was due" is still unrun.
 *
 * Everything else is unchanged and fails everywhere: a model that answered
 * without the canary is a control that proved nothing, whoever is asking.
 */

/** `verify` skips loudly on a provider refusal; the release gate fails on it. */
export type LiveCanaryMode = "verify" | "release-gate";

export function liveCanaryMode(
  env: NodeJS.ProcessEnv = process.env,
): LiveCanaryMode {
  return env["BYOLLM_RELEASE_GATE"] === "1" ? "release-gate" : "verify";
}

/**
 * Where a skipped canary is written down, at the repository root.
 *
 * `verify.sh` removes it before anything runs, so what it holds is about the
 * last `verify`; `record-verified.mjs` prints it into the log, and `tag.sh`
 * refuses to tag while it exists.
 */
const SKIP_MARKER = fileURLToPath(
  new URL("../../../../.live-canary-skipped", import.meta.url),
);

/** One finished CLI run: how it exited, and everything it said on both streams. */
export interface Run {
  readonly code: number | null;
  readonly out: string;
}

/** Spawn a CLI exactly as `runProcessJob` would, with an argv we choose. */
export async function spawnCli(
  binary: string,
  argv: readonly string[],
  prompt: string,
  options: { cwd?: string; home?: string } = {},
): Promise<Run> {
  const scratch =
    options.cwd ?? (await mkdtemp(join(tmpdir(), "byollm-job-canary-")));
  const env = childEnv();
  if (options.home !== undefined) env["HOME"] = options.home;
  try {
    return await new Promise<Run>((resolve) => {
      const child = spawn(binary, [...argv], {
        cwd: scratch,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
      });
      let out = "";
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 240_000);
      // stdout and stderr both: a leak that arrives on the diagnostic stream is
      // a leak, and this test's whole subject is a string appearing where it
      // should not.
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, out: `${out}\n${String(error)}` });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt, "utf8");
    });
  } finally {
    if (options.cwd === undefined)
      await rm(scratch, { recursive: true, force: true });
  }
}

/** The provider declined to serve the request, in its own words. */
export interface ProviderUnavailable {
  readonly provider: "claude" | "codex";
  readonly kind: "quota" | "auth";
  /** The CLI's own sentence. */
  readonly message: string;
  /** Epoch ms the CLI said it would be back, when it said so. */
  readonly until?: number;
}

/**
 * Did this run reach a refusal from the provider rather than a model turn?
 *
 * Each CLI on its own definition of failure, exactly as the daemon reads it:
 * codex from a terminal `error`/`turn.failed` event (it can exit zero on
 * one), claude from a non-zero exit. A model's *answer* is never searched —
 * a model asked about rate limits must not turn a canary into a skip.
 */
export function providerUnavailable(
  provider: "claude" | "codex",
  run: Run,
  now: number = Date.now(),
): ProviderUnavailable | undefined {
  if (provider === "codex") {
    const parsed = parseCodexOutput(run.out, now);
    if (parsed.ok) return undefined;
    const message = parsed.message.replace(/^the codex CLI failed: /u, "");
    if (parsed.code === "quota-exhausted")
      return {
        provider,
        kind: "quota",
        message,
        ...(parsed.until === undefined ? {} : { until: parsed.until }),
      };
    if (parsed.code === "unauthorized")
      return { provider, kind: "auth", message };
    return undefined;
  }
  if (run.code === 0) return undefined;
  const blocked = quotaBlock(run.out, now);
  if (blocked !== undefined)
    return {
      provider,
      kind: "quota",
      message: firstLine(blocked.detail),
      ...(blocked.until === undefined ? {} : { until: blocked.until }),
    };
  if (isAuthFailure(run.out))
    return { provider, kind: "auth", message: firstLine(run.out) };
  return undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  ).slice(0, 300);
}

/** The control's verdict: it leaked, the provider refused, or it proved nothing. */
export type ControlVerdict =
  | { readonly kind: "leaked"; readonly out: string }
  | {
      readonly kind: "provider-unavailable";
      readonly refusal: ProviderUnavailable;
      readonly out: string;
    }
  | { readonly kind: "inconclusive"; readonly out: string };

/**
 * How many times a control gets to demonstrate the leak before we call the
 * experiment inconclusive.
 *
 * Not defensive padding — the flake is measured, twice. The first `@~/` probe
 * of BY-01 answered "CANNOT" and then leaked the canary on three identical
 * runs; and that row's own first green run had the *codex* control decline to
 * reach for its shell, having reached for it on both forms an hour earlier. A
 * control's job is to show the path exists, and a model that could take the
 * path and chose not to has shown nothing either way.
 *
 * A provider refusal is not retried: the quota will not lift between two
 * attempts a second apart, and asking again only spends the time.
 */
const CONTROL_ATTEMPTS = 3;

/** Run the control until it leaks, the provider refuses, or attempts run out. */
export async function runControl(
  provider: "claude" | "codex",
  canary: string,
  attempt: () => Promise<Run>,
  now: () => number = Date.now,
): Promise<ControlVerdict> {
  let out = "";
  for (let tries = 0; tries < CONTROL_ATTEMPTS; tries += 1) {
    const run = await attempt();
    out = run.out;
    if (run.out.includes(canary)) return { kind: "leaked", out };
    const refusal = providerUnavailable(provider, run, now());
    if (refusal !== undefined)
      return { kind: "provider-unavailable", refusal, out };
  }
  return { kind: "inconclusive", out };
}

/** `2026-10-28`, in the local calendar the CLI's own clock was written in. */
function day(epochMs: number): string {
  const at = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The one line a landing log carries: `live canary skipped: codex quota until 2026-10-28`. */
function skipNote(refusal: ProviderUnavailable): string {
  return `live canary skipped: ${refusalLine(refusal)}`;
}

/** `codex quota until 2026-10-28` — who refused, why, and until when. */
function refusalLine(refusal: ProviderUnavailable): string {
  const when =
    refusal.until === undefined
      ? "no retry date given"
      : `until ${day(refusal.until)}`;
  return `${refusal.provider} ${refusal.kind} ${when}`;
}

/** What a test needs from vitest's context to skip itself with a reason. */
export interface Skipper {
  skip(note: string): void;
}

/**
 * Make a provider refusal mean what this run's mode says it means.
 *
 * Under `verify` it prints, records, and skips. Under the release gate it
 * fails, with the same refusal in the message.
 */
export function settleRefusal(
  refusal: ProviderUnavailable,
  what: string,
  context: Skipper,
  mode: LiveCanaryMode = liveCanaryMode(),
  marker: string = SKIP_MARKER,
): void {
  if (mode === "release-gate") {
    expect.fail(
      `PROVIDER_UNAVAILABLE under the release gate (BYOLLM_RELEASE_GATE=1): ` +
        `${what} did not run, and a release does not ship with its canary ` +
        `unrun.\n  ${refusalLine(refusal)}\n  ${refusal.provider} said: ` +
        refusal.message,
    );
  }
  const note = skipNote(refusal);
  // Written straight to stderr, not through `console.warn`: vitest drops a
  // test's console output when the test ends skipped — measured, the first
  // run of this printed nothing — and a skip's reason is shown only by some
  // reporters. A loud skip that is silent is the thing this replaces.
  process.stderr.write(
    `\n  ⚠ ${note} — ${what} did NOT run. ${refusal.provider} said: ` +
      `"${refusal.message}" (PROVIDER_UNAVAILABLE: a skip under verify, a ` +
      "failure under BYOLLM_RELEASE_GATE=1)\n\n",
  );
  const already = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  if (!already.split("\n").includes(note))
    appendFileSync(marker, `${note}\n`, "utf8");
  context.skip(note);
}

/**
 * The control's verdict, enforced: return on a leak, settle a refusal, fail
 * on anything else.
 */
export function requireLeak(
  verdict: ControlVerdict,
  what: string,
  inconclusive: string,
  context: Skipper,
  mode: LiveCanaryMode = liveCanaryMode(),
  marker: string = SKIP_MARKER,
): void {
  if (verdict.kind === "leaked") return;
  if (verdict.kind === "provider-unavailable") {
    settleRefusal(verdict.refusal, what, context, mode, marker);
    return;
  }
  expect.fail(`${inconclusive}\n${verdict.out.slice(0, 600)}`);
}

/**
 * Why BY-01's positive control fails: a mention *inside* the working directory
 * no longer expands. The sentence lives here so the fake-CLI test asserts the
 * one the live row prints.
 */
export const NOT_EXPANDED_INSIDE =
  "`--restricted` no longer expands a mention even INSIDE the working " +
  "directory. Containment is not weaker — it may be stronger — but " +
  "docs/security.md §3.2 says the file surface is CONFINED to the " +
  "working directory, and a confinement is not what this is any " +
  "more. Change the sentence, then change this case to match " +
  "whatever the CLI does now.";

/**
 * BY-01's positive control, enforced: a canary inside the working directory
 * must come back — #4167.
 *
 * It gets the control's retries, through {@link runControl} itself, for the
 * control's reason: a model that can read the file sometimes says "CANNOT"
 * anyway. One did, once, under the release gate on 2026-10-22 and passed six
 * of six after (#4163) — and with no retry that one refusal read as the CLI
 * having changed and blocked `tag.sh`. A real change does not go away on a
 * second ask, so it still fails, after every attempt has said the same.
 *
 * A refusal that a retry outlived is printed, not dropped: if the flake
 * becomes a habit, the run that passed is where it shows first.
 */
export async function requireExpandedInside(
  canary: string,
  attempt: () => Promise<Run>,
  what: string,
  context: Skipper,
  mode: LiveCanaryMode = liveCanaryMode(),
  marker: string = SKIP_MARKER,
  now: () => number = Date.now,
): Promise<void> {
  const said: string[] = [];
  const verdict = await runControl(
    "claude",
    canary,
    async () => {
      const run = await attempt();
      said.push(run.out);
      return run;
    },
    now,
  );
  if (verdict.kind === "provider-unavailable") {
    settleRefusal(verdict.refusal, what, context, mode, marker);
    return;
  }
  if (verdict.kind === "leaked") {
    const refused = said.slice(0, -1);
    if (refused.length > 0)
      process.stderr.write(
        `\n  ⚠ ${what}: expanded on attempt ${String(said.length)} of ` +
          `${String(CONTROL_ATTEMPTS)}; before that the model said:\n` +
          refused.map((out) => `    ${out.slice(0, 400)}\n`).join("") +
          "\n",
      );
    return;
  }
  expect.fail(
    `${NOT_EXPANDED_INSIDE}\n(not expanded on any of ${String(said.length)} ` +
      `attempts; the last said:)\n${verdict.out.slice(0, 400)}`,
  );
}
