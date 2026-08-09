import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendClass, BackendId } from "@byollm/protocol";
import type {
  Backend,
  BackendHealth,
  BackendRequest,
  BackendResult,
} from "./types.js";

/**
 * The exact argv this backend ever runs, minus the model.
 *
 * A frozen literal, not a builder, so there is no code path that appends to
 * it and no mechanism to pass job-supplied arguments
 * ({@link MUSTS.NO_SHELL_INTERPOLATION}). The adversarial suite asserts that
 * every hostile payload it throws produces exactly this argv.
 *
 * - `--print` — non-interactive, answer and exit.
 * - `--output-format text` — plain text, no envelope to misparse.
 * - `--tools ""` — the CLI's own switch for *disabling every built-in tool*.
 *   byollm_004 §2 requires the model have no tools; this is the flag that
 *   delivers it. Verified against the shipped CLI, not assumed.
 * - `--strict-mcp-config` with an empty `--mcp-config` — no MCP servers, and
 *   none inherited from the user's own settings.
 * - `--no-session-persistence` — a job leaves no session behind.
 */
const FIXED_ARGV = Object.freeze([
  "--print",
  "--output-format",
  "text",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--no-session-persistence",
]);

/**
 * Environment variables a `claude` child is allowed to see.
 *
 * Everything else is dropped, so a prompt that says "read your environment"
 * finds nothing worth having ({@link MUSTS.STRIPPED_CHILD_ENV}).
 *
 * `HOME` is present and that is a deliberate, documented compromise: the CLI
 * reads its subscription credentials from the user's own config directory, so
 * removing `HOME` would remove the authentication this backend exists to use.
 * The honest statement is in `docs/security.md` — the child can reach the
 * filesystem the user can reach, and what stops it doing anything with that
 * is having no tools, not the environment.
 *
 * `ANTHROPIC_API_KEY` is deliberately **absent**: byollm_002 requires that
 * billing cannot silently move from the subscription to a metered key.
 */
const ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
]);

/** Build the child's environment from the allowlist. */
export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // Signals to the CLI that it is not attached to a terminal, so it never
  // tries to render interactive UI into a pipe.
  env["CI"] = "1";
  return env;
}

/** The argv this backend would run for a given model. Exported for the suite. */
export function claudeArgv(model: string): readonly string[] {
  return Object.freeze([...FIXED_ARGV, "--model", model]);
}

/**
 * The process-class backend: the user's own `claude` CLI, on their own
 * subscription.
 *
 * Subscription-class, so its offer scope is locked to `self`
 * ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}) — one account runs one person's work.
 *
 * Every requirement of byollm_004 §2 applies here and is implemented here:
 * fixed argv, prompt on stdin, stripped environment, empty scratch `cwd`, no
 * inherited descriptors beyond the three std streams, hard timeout, hard
 * output cap.
 */
export class ClaudeCliBackend implements Backend {
  readonly id: BackendId = "claude-cli";
  readonly class: BackendClass = "process";
  readonly #binary: string;

  /**
   * @param binary - which executable to run. Defaults to `claude` and is
   * **not reachable from configuration**: {@link createBackend} constructs
   * this with no arguments, and {@link BackendInit} has no field for it. It
   * exists so the adversarial suite can substitute a probe that reports the
   * argv, environment, cwd and stdin it actually received — which is the only
   * way to *prove* byollm_004 §2 rather than assert it.
   */
  constructor(binary = "claude") {
    this.#binary = binary;
  }

  async health(): Promise<BackendHealth> {
    const version = await new Promise<string | null>((resolve) => {
      // execFile, never exec: no shell is involved even for our own fixed
      // arguments (the eslint rule bans the shell-invoking variants outright).
      execFile(
        this.#binary,
        ["--version"],
        { timeout: 10_000, env: childEnv() },
        (error, stdout) => {
          resolve(error ? null : stdout.trim());
        },
      );
    });

    if (version === null) {
      return {
        healthy: false,
        models: [],
        detail:
          "the `claude` CLI is not installed or not on PATH " +
          "(https://claude.com/claude-code)",
      };
    }
    // The CLI does not enumerate models, and inventing a list would breach
    // "never advertise what isn't real". The configured model is the claim,
    // and a wrong one surfaces as `model-not-found` on first use.
    return { healthy: true, models: [] };
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    const started = Date.now();
    // An empty directory of our own making. The child's `cwd` is never the
    // daemon's, never the user's home, and never anything a payload named.
    const scratch = await mkdtemp(join(tmpdir(), "byollm-job-"));

    try {
      return await this.#spawn(request, scratch, started);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async #spawn(
    request: BackendRequest,
    scratch: string,
    started: number,
  ): Promise<BackendResult> {
    return new Promise<BackendResult>((resolve) => {
      const child = spawn(this.#binary, claudeArgv(request.model), {
        cwd: scratch,
        env: childEnv(),
        // Exactly the three std streams. Nothing else is inherited, so the
        // child cannot reach a descriptor the daemon happens to hold open.
        stdio: ["pipe", "pipe", "pipe"],
        // No shell, ever. With `shell: false` the argv array is passed to
        // execvp verbatim and metacharacters in it are just bytes.
        shell: false,
        detached: false,
      });

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
        // SIGTERM first, SIGKILL shortly after: a wedged child must not be
        // able to outlive its budget by ignoring the polite signal.
        //
        // The escalation is gated on `exited`, which we set from the `close`
        // event, and NOT on `child.killed` — that flag means "a signal was
        // sent", not "the process died", so gating on it would mean the
        // SIGKILL never fires against exactly the child that ignores SIGTERM.
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
          message: `could not start the claude CLI: ${error.message}`,
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
                ? `the claude CLI exited with status ${String(code)}`
                : `the claude CLI failed: ${firstLine(stderr)}`,
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
}

/** First line of stderr, for a one-line diagnostic. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
