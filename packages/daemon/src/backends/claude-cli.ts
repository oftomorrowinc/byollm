import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
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

/**
 * The Windows half of the same compromise `HOME` documents above.
 *
 * The CLI stores its subscription credentials under the user's profile, which
 * on Windows is named by `USERPROFILE` / `APPDATA` rather than `HOME`. Without
 * them the child starts and then cannot authenticate — the backend reports
 * healthy and every job fails, which is a worse failure than not starting.
 *
 * `SystemRoot` and `windir` are here because Windows resolves core DLLs
 * (including the socket stack) through them; a child without them fails in
 * ways that look nothing like a missing variable. `TEMP`/`TMP` are the
 * platform's `TMPDIR`, and `PATHEXT` is how Windows resolves an extensionless
 * command name at all.
 *
 * This widens the allowlist on Windows only. The rule byollm_004 §2 states —
 * the child sees an allowlist, never the daemon's environment — is unchanged.
 */
const WINDOWS_ENV_ALLOWLIST = Object.freeze([
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
  "PATHEXT",
]);

/** Build the child's environment from the allowlist. */
export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const allowed =
    platform === "win32"
      ? [...ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]
      : ENV_ALLOWLIST;

  const env: Record<string, string> = {};
  for (const name of allowed) {
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

/** What to actually execute, and anything that must precede the CLI's own argv. */
export interface ClaudeLaunch {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Where the `claude` entry point really is on Windows.
 *
 * npm installs `claude` as `claude.cmd` and `claude.ps1` — there is no `.exe`.
 * Node refuses to spawn a `.cmd` without a shell (hardened after
 * CVE-2024-27980), so `spawn("claude")` fails with ENOENT and this backend can
 * never report healthy on Windows.
 *
 * `shell: true` would fix the symptom and breach
 * {@link MUSTS.NO_SHELL_INTERPOLATION}, so it is not on the table. Instead we
 * find the JavaScript the shim would have run and run it under the Node binary
 * already executing this daemon: no shell, and the CLI's own argv is still the
 * frozen literal above, passed through untouched.
 */
function findWindowsEntry(
  binary: string,
  source: NodeJS.ProcessEnv,
): string | null {
  const dirs = (source["PATH"] ?? "").split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    // The npm global layout: the shim sits beside the package it launches.
    const direct = join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    if (existsSync(direct)) return direct;

    // Otherwise read the shim, which names its target script. Cheap, and it
    // survives layouts we have not seen — pnpm and Volta both differ from npm.
    const shim = join(dir, `${binary}.cmd`);
    if (!existsSync(shim)) continue;
    try {
      const match = /"?([A-Za-z]:\\[^"\r\n]*?\.js|%~dp0[^"\r\n]*?\.js)"?/.exec(
        readFileSync(shim, "utf8"),
      );
      if (!match?.[1]) continue;
      const target = match[1].replace(/%~dp0\\?/i, `${dir}\\`);
      if (existsSync(target)) return target;
    } catch {
      // An unreadable shim is not an error worth failing over; try the next
      // directory and let health() report the honest "not installed".
    }
  }
  return null;
}

/**
 * Resolve what to spawn for the CLI on this platform.
 *
 * Everywhere but Windows this is the identity: the binary name, no prefix. The
 * caller's argv is unchanged on every platform, which is what keeps the
 * adversarial suite's argv assertions meaningful.
 */
export function resolveClaudeLaunch(
  binary = "claude",
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): ClaudeLaunch {
  if (platform !== "win32") return { command: binary, prefixArgs: [] };

  // A JavaScript entry point runs under this Node, wherever it came from. On
  // Unix a `#!/usr/bin/env node` script is executable and spawns directly;
  // Windows has no shebang, so the same file has to be handed to Node
  // explicitly. The adversarial suite's probe is exactly such a script, which
  // is why that suite could not run on Windows at all.
  if (/\.[cm]?js$/i.test(binary)) {
    return { command: process.execPath, prefixArgs: [binary] };
  }

  // A real executable needs no help.
  if (/[\\/]/.test(binary) || /\.(exe|com|bat|cmd)$/i.test(binary)) {
    return { command: binary, prefixArgs: [] };
  }

  const entry = findWindowsEntry(binary, source);
  return entry === null
    ? { command: binary, prefixArgs: [] }
    : { command: process.execPath, prefixArgs: [entry] };
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
      const launch = resolveClaudeLaunch(this.#binary);
      execFile(
        launch.command,
        [...launch.prefixArgs, "--version"],
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
      // Check before spawning, not only via the listener below: a job
      // cancelled between the claim and this line arrives with its signal
      // already aborted, and `addEventListener("abort")` never fires for a
      // signal that has already fired. Without this the child would spawn and
      // run to completion after the owner had already said stop.
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

      // The CLI's own argv is `claudeArgv(model)` on every platform. On Windows
      // `prefixArgs` carries the path to the script Node is being asked to run,
      // which is an argument to Node and not to the model's command line.
      const launch = resolveClaudeLaunch(this.#binary);
      const child = spawn(
        launch.command,
        [...launch.prefixArgs, ...claudeArgv(request.model)],
        {
          cwd: scratch,
          env: childEnv(),
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
