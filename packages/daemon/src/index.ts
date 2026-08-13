/**
 * `byollm` — what end users run.
 *
 * The CLI (`byollm connect`, `status`, `log`, `pause`, `allow`) is the
 * product surface; this module is the same machinery as a library, so the
 * conformance kit can drive a real daemon in-process instead of shelling out.
 *
 * @packageDocumentation
 */

export { Allowlist, normalizeOrigin, type AllowEntry } from "./allowlist.js";

export { main, runCli, type CliIo, type ExitCode } from "./cli.js";

export {
  ClaudeCliBackend,
  IMPLEMENTED_BACKEND_IDS,
  OpenAiHttpBackend,
  childEnv,
  claudeArgv,
  createBackend,
  type Backend,
  type BackendErrorCode,
  type BackendHealth,
  type BackendInit,
  type BackendRequest,
  type BackendResult,
} from "./backends/index.js";

export { Budgets, type BudgetDecision, type BudgetRefusal } from "./budgets.js";

export {
  ClientError,
  ProtocolClient,
  type ClientErrorKind,
  type ClientOptions,
} from "./client.js";

export { composePrompt } from "./compose.js";

export {
  DEFAULT_CONFIG,
  DaemonConfig,
  loadConfig,
  resolveConfig,
  type BackendConfig,
  type CommunityBudget,
  type ConfigProblem,
  type IngressRetention,
  type LoadedConfig,
  type Limits,
  type ResolvedRoute,
  type RouteConfig,
} from "./config.js";

export {
  connect,
  currentPlatform,
  type ConnectOptions,
  type ConnectResult,
} from "./connect.js";

export {
  IngressLog,
  hashText,
  stripControlChars,
  type IngressEntry,
  type IngressOptions,
  type OutcomeEntry,
  type PromptEntry,
} from "./ingress.js";

export { daemonPaths, defaultRoot, type DaemonPaths } from "./paths.js";

export { Pairings, type Pairing } from "./pairings.js";

export {
  Runner,
  type RunnerEvent,
  type RunnerOptions,
  type RunnerStatus,
} from "./runner.js";

export {
  BASE_URL_REFUSAL_MESSAGES,
  checkBaseUrl,
  type BaseUrlCheck,
  type BaseUrlRefusal,
} from "./ssrf.js";

/**
 * This daemon's version, reported on pairing and on every heartbeat.
 *
 * Kept in step with `package.json` by a test rather than by a build-time
 * define: an app's runner list shows this string, so a stale one is a lie
 * told to every user, and a literal that a test pins cannot drift quietly.
 */
export const DAEMON_VERSION = "0.1.0-alpha.2";
