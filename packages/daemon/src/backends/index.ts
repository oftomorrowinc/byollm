import { BACKEND_IDS, type BackendId } from "@byollm/protocol";
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
  switch (id) {
    case "openai-http":
      return new OpenAiHttpBackend(init);
    case "claude-cli":
      return new ClaudeCliBackend();
  }
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
