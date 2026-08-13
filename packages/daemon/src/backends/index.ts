import {
  BACKEND_IDS,
  backendDescriptor,
  type BackendId,
} from "@byollm/protocol";
import { ClaudeCliBackend } from "./claude-cli.js";
import { OpenAiHttpBackend } from "./openai-http.js";
import type { Backend, BackendInit } from "./types.js";

/**
 * Construct a backend instance.
 *
 * The switch is exhaustive over {@link BackendId}, so adding a backend to the
 * protocol registry without implementing it here is a compile error rather
 * than a runtime surprise — and adding one without adversarial rows fails the
 * suite's coverage check.
 */
export function createBackend(id: BackendId, init: BackendInit): Backend {
  // Providers are registry entries, not implementations (byollm_007 §3):
  // every HTTP-class id speaks OpenAI-compatible /v1/chat/completions, so they
  // all share one transport and one adversarial corpus. Adding a provider is a
  // line in the registry, not a new class to review.
  if (backendDescriptor(id).class === "process") {
    return new ClaudeCliBackend();
  }
  return new OpenAiHttpBackend(init);
}

/** Every backend the daemon can construct. */
export const IMPLEMENTED_BACKEND_IDS: readonly BackendId[] = BACKEND_IDS;

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
