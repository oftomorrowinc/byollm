/**
 * `@byollm/server` — the app-side half of BYOLLM.
 *
 * Two surfaces, deliberately separate:
 *
 * - {@link ByollmHandlers} / {@link createFetchHandler} serve the five
 *   protocol endpoints to daemons.
 * - {@link ByollmApp} is what your own code calls: enqueue, approve a
 *   pairing, read a result, revoke a runner.
 *
 * Between them sits {@link ByollmStore}, the adapter seam.
 * {@link MemoryStore} is the reference implementation; an adapter is correct
 * when `@byollm/conformance` passes against it.
 *
 * @packageDocumentation
 */

export {
  ByollmApp,
  normalizeUserCode,
  type AvailabilityQuery,
  type ByollmAppOptions,
  type JobHandle,
  type NoRunnerReason,
  type RunnerAvailability,
} from "./app.js";

export {
  NoRunnerAvailableError,
  PollingDelivery,
  ResultTimeoutError,
  type PollingDeliveryDeps,
  type ResultDelivery,
  type WaitOptions,
} from "./delivery.js";

export {
  ByollmHandlers,
  SERVED_PROTOCOL_VERSION,
  type HandlerConfig,
  type HandlerResult,
} from "./handlers.js";

export { createFetchHandler, routeEndpoint, signatureFrom } from "./http.js";

export { formatSiteKeys, generateSiteKeys, siteKeysFromEnv } from "./keys.js";
export { CloudLane, RelayUnavailable } from "./cloud.js";
export type { CloudLaneOptions, PumpReport } from "./cloud.js";

export {
  generateDeviceCode,
  generateJobId,
  generateRunnerId,
  generateUserCode,
  hashSecret,
  secretsMatch,
} from "./ids.js";

export {
  MemoryStore,
  capabilityFor,
  type MemoryStoreOptions,
} from "./memory.js";

export type {
  EnqueueInput,
  JobRecord,
  PairingRecord,
  RunnerRecord,
} from "./records.js";

export type {
  ApproveArgs,
  ByollmStore,
  ClaimArgs,
  AdoptArgs,
  CompleteArgs,
  CompleteHolder,
  CompleteResult,
  JobStore,
  ReleaseArgs,
  RenewArgs,
  RenewResult,
  RunnerStore,
  TouchArgs,
} from "./store.js";
