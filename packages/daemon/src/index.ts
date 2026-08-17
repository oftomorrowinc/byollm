/**
 * `byollm` — what end users run.
 *
 * The CLI (`byollm connect`, `status`, `log`, `pause`, `allow`) is the
 * product surface; this module is the same machinery as a library, so the
 * conformance kit can drive a real daemon in-process instead of shelling out.
 *
 * @packageDocumentation
 */

import { PROTOCOL_VERSION } from "@byollm/protocol";

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

export { DeviceIdentity } from "./identity.js";

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

export { SpendLedger, estimateCents } from "./spend.js";

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
export const DAEMON_VERSION = "0.1.0-alpha.8";

/**
 * Everything needed to reason about one daemon — byollm_010 §5.
 *
 * `--version` used to print a package version and nothing else, which is the
 * least useful version string a distributed daemon can have. "It doesn't work
 * on Windows" with no platform, no Node version and no protocol version is
 * the most expensive sentence an open-source project receives, and every
 * later capability — deprecation warnings, a minimum-supported-version
 * policy, "your daemon is N releases behind" — needs these facts to exist.
 *
 * The same tuple goes in the handshake (byollm_009 §4), deliberately: a
 * support conversation and a version policy should be arguing about the same
 * numbers.
 */
export interface DaemonVersion {
  readonly daemon: string;
  readonly protocol: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly node: string;
}

export function daemonVersion(): DaemonVersion {
  return {
    daemon: DAEMON_VERSION,
    protocol: PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  };
}

/** One line, for `--version` and for pasting into an issue. */
export function formatVersion(v: DaemonVersion = daemonVersion()): string {
  return (
    `byollm ${v.daemon} (protocol ${v.protocol})\n` +
    `${v.platform}-${v.arch}, node ${v.node}\n`
  );
}
