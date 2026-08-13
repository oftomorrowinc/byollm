/**
 * `@byollm/protocol` — the BYOLLM wire contract.
 *
 * Types, zod schemas, and the pure rules (audience matching, lifecycle
 * transitions, the subscription self-lock) that the daemon and the server
 * both enforce. Nothing here does I/O, so both sides can run the identical
 * rule and neither has to trust the other's answer.
 *
 * The normative prose lives in `docs/protocol.md`; {@link MUSTS} is that
 * document's requirements as data, and the conformance kit fails if any of
 * them lacks a test.
 *
 * @packageDocumentation
 */

export {
  Audience,
  AUDIENCES,
  effectiveOfferScope,
  matchAudience,
  MatchRefusal,
  OFFER_SCOPES,
  OfferScope,
  REFUSAL_MESSAGES,
  type MatchDaemon,
  type SpendConsent,
  type MatchJob,
  type MatchResult,
} from "./audience.js";

export {
  BACKEND_IDS,
  BACKENDS,
  BackendClass,
  BackendCost,
  BackendIdSchema,
  backendDescriptor,
  isBackendId,
  isLocalHost,
  resolveCost,
  type BackendDescriptor,
  type BackendId,
} from "./backends.js";

export {
  ChatMessage,
  ChatPayload,
  GeneratePayload,
  JOB_KINDS,
  JobKind,
  KindedPayload,
  PAYLOAD_LIMITS,
  isJobKind,
  payloadTextLength,
  type PayloadFor,
} from "./kinds.js";

export {
  ClaimedJob,
  DeliveredResult,
  JobOutcome,
  JobPayload,
  JobResultCanceled,
  JobResultError,
  JobResultOk,
  JobState,
  Lease,
  ResultProvenance,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  provenanceFor,
} from "./job.js";

export {
  MUST_IDS,
  MUSTS,
  mustsVerifiedBy,
  type Must,
  type MustEnforcer,
  type MustId,
  type MustVerification,
} from "./musts.js";

export {
  Capability,
  CapabilityMatrix,
  ClaimRequest,
  ClaimResponse,
  ENDPOINTS,
  ERROR_STATUS,
  HeartbeatRequest,
  HeartbeatResponse,
  PROTOCOL_PREFIX,
  PROTOCOL_VERSION,
  PairPollRequest,
  PairPollResponse,
  PairRequest,
  PairStartRequest,
  PairStartResponse,
  ReleaseRequest,
  ReleaseResponse,
  ResultRequest,
  ResultResponse,
  WireError,
  WireErrorCode,
  type Endpoint,
} from "./wire.js";
