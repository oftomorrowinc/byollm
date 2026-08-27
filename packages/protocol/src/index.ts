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
  isCloudTaggedModel,
  backendName,
  classifyCost,
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
  RunMetadata,
  SealedOutcome,
  JobPayload,
  JobResultCanceled,
  JobResultError,
  JobResultOk,
  // byollm_016 Phase B. Public because a site handles these: a refusal is a
  // terminal answer an app must render, not an internal routing detail.
  JobRefused,
  RefusalReason,
  JobState,
  ClaimedStub,
  JobStub,
  Lease,
  SIZE_CLASS_LIMITS,
  SizeClass,
  sizeClassCeiling,
  sizeClassOf,
  ResultProvenance,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  provenanceFor,
} from "./job.js";

export {
  ENVELOPE_MAX_AGE_MS,
  EnvelopeDirection,
  SealedEnvelope,
  cryptoReady,
  open,
  seal,
  type EnvelopeContext,
  type EnvelopeFailure,
  type OpenResult,
} from "./envelope.js";

export {
  MAX_CLOCK_SKEW_MS,
  RequestSignature,
  canonicalRequest,
  signRequest,
  signSiteRequest,
  verifyRequest,
  verifySiteRequest,
  type SignatureFailure,
} from "./signing.js";

export {
  ENCRYPTION_KEY_CONTEXT,
  PublicIdentity,
  StoredKeys,
  fingerprint,
  generateKeys,
  keyId,
  publicIdentityOf,
  signWith,
  verifyPublicIdentity,
  verifyWith,
} from "./keys.js";

export {
  Manifest,
  Purpose,
  MAX_PURPOSES,
  RESERVED_PURPOSE,
  singlePurposeManifest,
} from "./manifest.js";

export {
  CLOCK_ATTRIBUTION_MS,
  CLOCK_SKEW_WARN_MS,
  GRANT_CONTEXT,
  GRANT_MAX_AGE_MS,
  GRANT_SIGNED_FIELDS,
  SignedGrant,
  grantStatement,
  signGrant,
  verifyGrant,
  type GrantClaims,
  type GrantRefusal,
} from "./grant.js";

export {
  MAX_SUCCESSION_CHAIN,
  RETIREMENT_WINDOW_MS,
  SUCCESSION_CONTEXT,
  Succession,
  signSuccession,
  successionStatement,
  verifyLink,
  walkSuccession,
  type SuccessionFailure,
  type SuccessionWalk,
} from "./succession.js";

export {
  MUST_IDS,
  MUSTS,
  kindsOf,
  // Nameable because `Must.verifiedBy` has this type and `Must` is public —
  // the same lesson `Grant` taught in alpha.28: an exported interface whose
  // field types are private is a contract nobody can sign.
  type MustVerifiedBy,
  mustsVerifiedBy,
  type Must,
  type MustEnforcer,
  type MustId,
  type MustVerification,
} from "./musts.js";

export {
  Capability,
  CapabilityMatrix,
  WithheldKind,
  ClaimRequest,
  ClaimResponse,
  ENDPOINTS,
  ERROR_STATUS,
  GrantRef,
  HeartbeatRequest,
  HeartbeatResponse,
  MIN_PROTOCOL_VERSION,
  FetchRequest,
  FetchResponse,
  PROTOCOL_PREFIX,
  SUPPORTED_PROTOCOL_VERSIONS,
  checkProtocolVersion,
  declaredVersion,
  type VersionRefusal,
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
  ResultDisposition,
} from "./wire.js";
