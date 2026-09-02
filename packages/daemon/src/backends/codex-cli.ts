import { execFile } from "node:child_process";
import type { BackendClass, BackendId } from "@byollm/protocol";
import { childEnv, resolveCliLaunch } from "./claude-cli.js";
import { isAuthFailure, runProcessJob } from "./process-backend.js";
import type {
  Backend,
  BackendErrorCode,
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
 * - `--json` — a terminal event decides the outcome. Codex can report
 *   `turn.failed` and still exit zero, so process status is not success.
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
  "--json",
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

/** The meaning of one complete `codex exec --json` stream. */
export type CodexOutput =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: BackendErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One bounded line from a provider diagnostic, for the device owner only. */
function diagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = Array.from(value, (character) => {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 31 || codeUnit === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 2_000);
  return text === "" ? undefined : text;
}

function failureMessage(event: Record<string, unknown>): string {
  const error = record(event["error"]);
  return (
    diagnostic(event["message"]) ??
    diagnostic(error?.["message"]) ??
    "codex reported an error"
  );
}

function classifyFailure(message: string): {
  readonly code: BackendErrorCode;
  readonly retryable: boolean;
} {
  // A provider rate-limit is not necessarily a spent subscription. Keep this
  // narrow: false exhaustion would hide capacity that still exists.
  if (
    /\busage limit\b/iu.test(message) ||
    /\bout of (?:credits?|quota)\b/iu.test(message) ||
    /\b(?:credits?|quota) (?:is |are )?exhausted\b/iu.test(message)
  ) {
    return { code: "quota-exhausted", retryable: true };
  }
  if (isAuthFailure(message)) {
    return { code: "unauthorized", retryable: false };
  }
  return { code: "backend-error", retryable: false };
}

/**
 * Interpret Codex's JSONL stream without trusting its process exit status.
 *
 * Codex can emit `error` and `turn.failed` and still exit zero. Treating that
 * status as success hands the provider's failure text to the site as though it
 * were a model answer. A run succeeds only when the stream contains
 * `turn.completed`; a terminal error wins when it appears first.
 *
 * Unknown and malformed rows are inert. Model prose is read only from
 * `item.completed` and is never searched for error words, so an answer that
 * discusses a usage limit cannot withdraw working capacity.
 */
export function parseCodexOutput(output: string): CodexOutput {
  const messages: string[] = [];

  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === "") continue;

    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    if (event === undefined) continue;

    const type = event["type"];
    if (type === "item.completed") {
      const item = record(event["item"]);
      if (item?.["type"] === "agent_message") {
        const text = item["text"] ?? item["message"];
        if (typeof text === "string" && text !== "") messages.push(text);
      }
      continue;
    }

    if (type === "error" || type === "turn.failed") {
      const detail = failureMessage(event);
      const classified = classifyFailure(detail);
      return {
        ok: false,
        ...classified,
        message: `the codex CLI failed: ${detail}`,
      };
    }

    if (type === "turn.completed") {
      return { ok: true, text: messages.join("\n") };
    }
  }

  return {
    ok: false,
    code: "backend-error",
    message: "the codex CLI ended without a terminal event",
    retryable: false,
  };
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
    const result = await runProcessJob({
      launch: resolveCliLaunch(this.#binary, "@openai/codex"),
      argv: codexArgv(request.model),
      env: childEnv(),
      displayName: "the codex CLI",
      request,
      started,
    });
    if (!result.ok) return result;

    const outcome = parseCodexOutput(result.text);
    return { ...outcome, durationMs: result.durationMs };
  }
}
