import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BackendClass, BackendId } from "@byollm/protocol";
import { runProcessJob } from "./process-backend.js";
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
 *
 * `USER` is here for the same reason as `HOME`, found the hard way on
 * 2026-08-25 during the first cross-user job. On macOS the CLI keeps its
 * credentials in the login Keychain rather than under `HOME`, and reaching
 * them needs `USER`; without it every run answers "Not logged in · Please run
 * /login" and exits non-zero.
 *
 * This is exactly the failure the Windows note below predicts and it arrived
 * on the other platform first: **the backend reports healthy and every job
 * fails.** The health check runs `--version`, which needs no credentials, so
 * nothing between install and the first real prompt says anything is wrong.
 * `LOGNAME` carries the same name and does not fix it — tested, not assumed —
 * so it stays out.
 */
const ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
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
  npmPackage: string,
): ClaudeLaunch | null {
  const dirs = (source["PATH"] ?? "").split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    // The npm package that owns this binary, so a second process backend gets
    // the same hard-won shim handling rather than its own copy. Split here
    // rather than stored pre-split: a scope and a name is how npm writes it
    // and how a reader recognises it.
    const pkg = join(dir, "node_modules", ...npmPackage.split("/"));

    // Claude Code 2.x ships a native executable rather than a script. Node
    // spawns a real `.exe` without a shell, so this case needs none of the
    // indirection below — and checking it first matters, because the 1.x
    // layout it replaced is what the rest of this function looks for.
    //
    // Missing this is what made every route unhealthy the day the CLI updated:
    // no `cli.js`, a shim naming an `.exe` rather than a script, and so a
    // fallback to spawning `claude` bare — which on Windows is the extensionless
    // shim Node refuses to run.
    const exe = join(pkg, "bin", `${binary}.exe`);
    if (existsSync(exe)) return { command: exe, prefixArgs: [] };

    // The 1.x npm global layout: a JS entry beside the shim that launches it.
    const direct = join(pkg, "cli.js");
    if (existsSync(direct)) {
      return { command: process.execPath, prefixArgs: [direct] };
    }

    // Otherwise read the shim, which names its target. Cheap, and it survives
    // layouts we have not seen — pnpm and Volta both differ from npm.
    const shim = join(dir, `${binary}.cmd`);
    if (!existsSync(shim)) continue;
    try {
      // Both spellings of the shim's own directory appear in the wild:
      // `%~dp0` from npm's older template, `%dp0%` from the current one.
      const match =
        /"?([A-Za-z]:\\[^"\r\n]*?\.(?:js|exe)|%~?dp0%?[^"\r\n]*?\.(?:js|exe))"?/i.exec(
          readFileSync(shim, "utf8"),
        );
      if (!match?.[1]) continue;
      // Rebuilt with `join` rather than string substitution, and split on
      // either separator: a shim names its target relative to itself, and the
      // separator it uses is whichever npm happened to write. Concatenating
      // produced a mixed-separator path that resolves on Windows and nowhere
      // else — which is precisely the shape a cross-platform test needs.
      const target = /^[A-Za-z]:/.test(match[1])
        ? match[1]
        : join(
            dir,
            ...match[1].replace(/^%~?dp0%?[\\/]?/i, "").split(/[\\/]+/),
          );
      if (!existsSync(target)) continue;
      return /\.exe$/i.test(target)
        ? { command: target, prefixArgs: [] }
        : { command: process.execPath, prefixArgs: [target] };
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
const launchCache = new Map<string, ClaudeLaunch>();

/** Drop the memo, for tests that change PATH between calls. */
export function resetClaudeLaunchCache(): void {
  launchCache.clear();
}

export function resolveClaudeLaunch(
  binary = "claude",
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): ClaudeLaunch {
  return resolveCliLaunch(
    binary,
    "@anthropic-ai/claude-code",
    platform,
    source,
  );
}

/**
 * Resolve what to spawn for a CLI-backed backend on this platform.
 *
 * Generalised from `resolveClaudeLaunch` when `codex-cli` arrived. Everything
 * here except the npm package name was already backend-agnostic — the Windows
 * shim problem is npm's, not Anthropic's — and a second copy of a function
 * that parses `.cmd` shims with a regex is not something this codebase should
 * own twice.
 */
export function resolveCliLaunch(
  binary: string,
  npmPackage: string,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): ClaudeLaunch {
  // Memoized because this runs on every `health()` and every `execute()`, and
  // on Windows walks each PATH entry with two `existsSync` calls. At the
  // default concurrency that is a synchronous filesystem crawl on the job
  // dispatch path, blocking the event loop while other jobs are in flight.
  //
  // Safe to cache: the answer is a function of the binary name, the platform
  // and PATH, none of which change meaningfully inside one daemon process. A
  // CLI installed while the daemon runs is picked up on restart — the same
  // thing already true of config.
  const key = `${platform}\u0000${binary}\u0000${npmPackage}\u0000${source["PATH"] ?? ""}`;
  const cached = launchCache.get(key);
  if (cached) return cached;
  const resolved = resolveUncached(binary, platform, source, npmPackage);
  launchCache.set(key, resolved);
  return resolved;
}

function resolveUncached(
  binary: string,
  platform: NodeJS.Platform,
  source: NodeJS.ProcessEnv,
  npmPackage: string,
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

  return (
    findWindowsEntry(binary, source, npmPackage) ?? {
      command: binary,
      prefixArgs: [],
    }
  );
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

  /**
   * One real, tiny call — the only way to learn whether credentials work.
   *
   * `--version` answers "is the binary here", which was never the question.
   * This asks the question, and pays for it: a handful of tokens against the
   * owner's own subscription, at daemon start rather than on every heartbeat.
   *
   * A failure here is reported rather than thrown, and the runner treats an
   * `unauthorized` exactly as it treats one from a real job — the service is
   * withdrawn and the owner is told once.
   */
  async canary(model: string): Promise<BackendHealth> {
    const result = await this.execute({
      model,
      prompt: "Reply with the single word: ok",
      timeoutMs: 30_000,
      // Enough for a word and a newline, and small enough that a chatty
      // model's answer cannot make this expensive.
      maxOutputBytes: 256,
      signal: new AbortController().signal,
    });
    return result.ok
      ? { healthy: true, models: [] }
      : { healthy: false, models: [], detail: result.message };
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
    // The spawn itself lives in `process-backend.ts` — one implementation of
    // byollm_004 §2's machinery for every process backend, because two copies
    // of a scratch cwd, a kill escalation and an output ceiling are two places
    // for them to drift apart. What stays here is the part that is genuinely
    // this backend's: which binary, and the frozen argv that turns its tools
    // off.
    return runProcessJob({
      launch: resolveClaudeLaunch(this.#binary),
      argv: claudeArgv(request.model),
      env: childEnv(),
      displayName: "the claude CLI",
      request,
      started,
    });
  }
}
