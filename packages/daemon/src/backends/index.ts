import { backendDescriptor, type BackendId } from "@byollm/protocol";
import { ClaudeCliBackend } from "./claude-cli.js";
import { CodexCliBackend } from "./codex-cli.js";
import { OpenAiHttpBackend } from "./openai-http.js";
import type { Backend, BackendInit } from "./types.js";

/**
 * Construct a backend instance.
 *
 * Exhaustive over {@link BackendClass}, and now actually so — cloud_008 Tier
 * 3, finding 15. The docstring used to claim "the switch is exhaustive over
 * `BackendId`, so adding a backend to the protocol registry without
 * implementing it here is a compile error", and there was no switch: an `if`
 * on `class === "process"` with everything else falling through to the HTTP
 * transport. A backend class added to the registry would have got an
 * OpenAI-compatible client and failed at runtime, in the shape the comment
 * promised was impossible.
 *
 * The `never` assignment is what makes the claim true. It costs one line and
 * fails at compile time in the file that has to change.
 *
 * Providers are still registry entries rather than implementations
 * (byollm_007 §3): every HTTP-class id speaks the same
 * `/v1/chat/completions`, so they share one transport and one adversarial
 * corpus. Adding a *provider* is a line in the registry. Adding a *class* is
 * this function.
 */
export function createBackend(id: BackendId, init: BackendInit): Backend {
  const kind = backendDescriptor(id).class;
  switch (kind) {
    // Process class dispatches by **id**, not by class, and the difference is
    // not stylistic. `case "process": return new ClaudeCliBackend()` was
    // correct for exactly as long as there was one process backend; the
    // moment `codex-cli` was registered it inherited Claude's frozen argv —
    // right class, wrong program. The coverage check now asserts the
    // constructed id, which is what caught it.
    case "process":
      return createProcessBackend(id);
    // HTTP class dispatches by class on purpose. Providers are registry
    // entries rather than implementations (byollm_007 §3): every HTTP id
    // speaks the same `/v1/chat/completions`, so they share one transport and
    // one adversarial corpus, and adding a provider stays a line in the
    // registry.
    case "http":
      return new OpenAiHttpBackend(init);
    default: {
      const unimplemented: never = kind;
      throw new Error(
        `no backend implementation for class ${String(unimplemented)}`,
      );
    }
  }
}

/**
 * One binary per process backend, chosen exhaustively.
 *
 * The `never` is what makes registering a process backend without writing its
 * adapter a compile error in this file, rather than a runtime surprise in
 * somebody's job. An argv is the whole of what a process backend is, so there
 * is nothing here to share and no sensible default to fall through to.
 */
function createProcessBackend(id: BackendId): Backend {
  switch (id) {
    case "claude-cli":
      return new ClaudeCliBackend();
    case "codex-cli":
      return new CodexCliBackend();
    default:
      throw new Error(`no process backend implementation for ${id}`);
  }
}

export { ClaudeCliBackend, childEnv, claudeArgv } from "./claude-cli.js";
export { CodexCliBackend, codexArgv } from "./codex-cli.js";
export { OpenAiHttpBackend } from "./openai-http.js";
export type {
  Backend,
  BackendErrorCode,
  BackendHealth,
  BackendInit,
  BackendRequest,
  BackendResult,
} from "./types.js";
