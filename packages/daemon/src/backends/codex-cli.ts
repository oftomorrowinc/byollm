import { execFile } from "node:child_process";
import type { BackendClass, BackendId } from "@byollm/protocol";
import { childEnv, resolveCliLaunch } from "./claude-cli.js";
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
 * A frozen literal, not a builder, so there is no code path that appends to it
 * and no mechanism to pass job-supplied arguments
 * ({@link MUSTS.NO_SHELL_INTERPOLATION}).
 *
 * **Codex is an agent, and byollm_004 §2 says the model gets no tools.** That
 * is not a default here — it is a list of switches, and every one of them was
 * verified against the shipped binary rather than read off a help page. The
 * default feature set of `@openai/codex` 0.149 has `shell_tool`,
 * `unified_exec`, `browser_use`, `browser_use_full_cdp_access`, `computer_use`,
 * `hooks`, `plugins`, `apps`, `multi_agent`, `image_generation` and
 * `skill_search` all *stable and on*. A backend that shipped without disabling
 * them would have handed any site the owner trusts a shell and a browser on the
 * owner's machine.
 *
 * How it was verified, because "we passed some flags" is not evidence: a canary
 * string was written to a file in the child's directory and the model was asked
 * to read it. With these flags it answers that it has no file-reading tool and
 * the canary never appears; with them removed it returns the canary verbatim.
 * The control is the half that matters — without it the test would pass against
 * a model that was merely being agreeable. `codex-tools-disabled.test.ts` keeps
 * that check runnable rather than a memory.
 *
 * - `exec` — the non-interactive subcommand; answers and exits.
 * - `--skip-git-repo-check` — **required**, not hygiene. Codex refuses to run
 *   outside a trusted git directory, and byollm_004 §2 requires the child's cwd
 *   be an empty scratch dir, which never is one. Without this every job fails
 *   before the model is reached.
 * - `-s read-only` — the sandbox for model-generated commands. Belt to the
 *   braces of the disables above: if a future release renames a feature flag,
 *   this still bounds what a tool could do.
 * - `--ephemeral` — a job leaves no session behind.
 * - `--ignore-user-config` — the owner's own `config.toml` does not reach this
 *   child. A daemon whose behaviour changed because a person edited their
 *   personal Codex settings would be a daemon whose guarantees are advisory.
 * - `--color never` — plain bytes, no escape sequences to misparse.
 */
const FIXED_ARGV = Object.freeze([
  "exec",
  "--skip-git-repo-check",
  "-s",
  "read-only",
  "--ephemeral",
  "--ignore-user-config",
  "--color",
  "never",
  "--disable",
  "shell_tool",
  "--disable",
  "unified_exec",
  "--disable",
  "browser_use",
  "--disable",
  "browser_use_external",
  "--disable",
  "browser_use_full_cdp_access",
  "--disable",
  "computer_use",
  "--disable",
  "hooks",
  "--disable",
  "plugins",
  "--disable",
  "apps",
  "--disable",
  "multi_agent",
  "--disable",
  "image_generation",
  "--disable",
  "skill_search",
]);

/** The argv for one call, model included. Frozen, and never payload-derived. */
export function codexArgv(model: string): readonly string[] {
  return Object.freeze([...FIXED_ARGV, "--model", model]);
}

/**
 * The process-class backend for OpenAI's Codex CLI, on the owner's ChatGPT
 * plan.
 *
 * Subscription-class, so its offer scope is locked to its owner
 * ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}) — one account runs one person's work.
 * That lock is doing more here than it does for `claude-cli`: it is the floor
 * under the tool disables above, so that even a future release which renames a
 * flag out from under us cannot expose the owner's machine to *other people's*
 * prompts. It does not bound the sites the owner has consented to, which is why
 * the disables are verified rather than trusted.
 */
export class CodexCliBackend implements Backend {
  readonly id: BackendId = "codex-cli";
  readonly class: BackendClass = "process";
  readonly signIn = "run `codex login`";
  readonly #binary: string;

  /**
   * @param binary - which executable to run. Defaults to `codex` and is **not
   * reachable from configuration**, exactly as for `claude-cli`: it exists so
   * the adversarial suite can substitute a probe that reports the argv,
   * environment, cwd and stdin it actually received.
   */
  constructor(binary = "codex") {
    this.#binary = binary;
  }

  async health(): Promise<BackendHealth> {
    const version = await new Promise<string | null>((resolve) => {
      // execFile, never exec: no shell is involved even for our own fixed
      // arguments.
      const launch = resolveCliLaunch(this.#binary, "@openai/codex");
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
          "the `codex` CLI is not installed or not on PATH " +
          "(npm i -g @openai/codex)",
      };
    }
    // `--version` succeeds whether or not anybody has signed in, so this
    // reports installed rather than ready, and the distinction is deliberate.
    // An unauthenticated CLI exits non-zero with an empty stdout on the first
    // real call, which surfaces as `backend-error` on that job — visible, and
    // attributable. Probing auth here would mean a network round trip on every
    // heartbeat to answer a question the first job answers for free.
    return { healthy: true, models: [] };
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    const started = Date.now();
    return runProcessJob({
      launch: resolveCliLaunch(this.#binary, "@openai/codex"),
      argv: codexArgv(request.model),
      env: childEnv(),
      displayName: "the codex CLI",
      request,
      started,
    });
  }
}
