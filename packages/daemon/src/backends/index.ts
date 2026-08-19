import { backendDescriptor, type BackendId } from "@byollm/protocol";
import { ClaudeCliBackend } from "./claude-cli.js";
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
    case "process":
      return new ClaudeCliBackend();
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

export { ClaudeCliBackend, childEnv, claudeArgv } from "./claude-cli.js";
export { OpenAiHttpBackend } from "./openai-http.js";
export type {
  Backend,
  BackendErrorCode,
  BackendHealth,
  BackendInit,
  BackendRequest,
  BackendResult,
} from "./types.js";
