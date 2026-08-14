import { z } from "zod";
import { PublicIdentity } from "./keys.js";
import { OfferScope } from "./audience.js";
import { BackendClass, BackendIdSchema } from "./backends.js";
import { ClaimedJob, JobOutcome } from "./job.js";
import { JobKind } from "./kinds.js";

/** Protocol version carried on every request; servers refuse what they can't speak. */
export const PROTOCOL_VERSION = "0" as const;

/**
 * Every protocol version this build can serve, **oldest first**.
 *
 * One entry today. It is a list rather than a constant because the shape of
 * the check is the point: a server supporting two versions through a
 * migration should not need a different code path from one supporting one.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  PROTOCOL_VERSION,
]) as readonly string[];

/**
 * The oldest version this build will talk to — derived, not declared.
 *
 * Stating it separately would be a second thing to keep in step with the list
 * above, and the failure would be silent: a minimum that no longer matches
 * what is supported produces a refusal naming a version the server would in
 * fact have accepted.
 */
export const MIN_PROTOCOL_VERSION: string =
  SUPPORTED_PROTOCOL_VERSIONS[0] ?? PROTOCOL_VERSION;

/** A structured refusal, so a daemon can say something useful to its owner. */
export interface VersionRefusal {
  readonly error: "unsupported-protocol-version";
  readonly message: string;
  readonly supported: readonly string[];
  readonly minimum: string;
}

/**
 * Check the protocol version on an incoming request
 * ({@link MUSTS.VERSION_HANDSHAKE_REQUIRED}).
 *
 * Returns a refusal, or `null` to proceed.
 *
 * **A missing version is refused the same way a wrong one is.** That is the
 * half worth stating: before this existed, the version travelled as a
 * `z.literal` inside each endpoint's schema, so a mismatch surfaced as a
 * generic `bad-request` — a daemon and a server discovered they disagreed by
 * failing, with nothing in the response naming the disagreement. An error a
 * user cannot act on is barely better than a hang.
 *
 * The message names the fix, because the person reading it is usually the one
 * who has to apply it.
 */
export function checkProtocolVersion(body: unknown): VersionRefusal | null {
  // `hasOwn`, not `in`: `in` walks the prototype chain, and a version check
  // should read what the request actually carried rather than something an
  // object happens to inherit. Not reachable from a JSON body today, which is
  // the reason to fix it now rather than after it is.
  const declared =
    typeof body === "object" &&
    body !== null &&
    Object.hasOwn(body, "protocolVersion")
      ? (body as { protocolVersion: unknown }).protocolVersion
      : undefined;

  if (typeof declared !== "string" || declared.length === 0) {
    return {
      error: "unsupported-protocol-version",
      message:
        "this request declared no protocol version. Upgrade the daemon: " +
        "`npm i -g byollm@alpha`.",
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      minimum: MIN_PROTOCOL_VERSION,
    };
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
    return {
      error: "unsupported-protocol-version",
      message:
        `this server speaks protocol ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")} ` +
        `and the daemon asked for ${declared}. ` +
        (declared < MIN_PROTOCOL_VERSION
          ? "Upgrade the daemon: `npm i -g byollm@alpha`."
          : "This daemon is newer than the server; the server needs upgrading."),
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      minimum: MIN_PROTOCOL_VERSION,
    };
  }

  return null;
}

/** The path prefix all endpoints mount under. */
export const PROTOCOL_PREFIX = "/byollm" as const;

/** The five endpoint names, in the order byollm_001 lists them. */
export const ENDPOINTS = Object.freeze([
  "pair",
  "claim",
  "heartbeat",
  "result",
  "release",
] as const);
export type Endpoint = (typeof ENDPOINTS)[number];

/**
 * One entry of the capability matrix: a kind this daemon can actually serve,
 * right now, with the backend and model that would serve it.
 *
 * Derived from owner config intersected with detected reality
 * ({@link MUSTS.CAPABILITY_IS_DETECTED}) — a configured-but-unreachable
 * backend must not appear here. Carries `backendClass` so the app can tell
 * whether a result came from a sandboxed spawn or an HTTP call
 * (byollm_001 Rev 1 §A).
 */
export const Capability = z
  .object({
    kind: JobKind,
    backendId: BackendIdSchema,
    backendClass: BackendClass,
    model: z.string().min(1),
    offerScope: OfferScope,
  })
  .strict();
export type Capability = z.infer<typeof Capability>;

/** The capability matrix a daemon advertises. */
export const CapabilityMatrix = z.array(Capability);
export type CapabilityMatrix = z.infer<typeof CapabilityMatrix>;

// ---------------------------------------------------------------------------
// 1. POST /byollm/pair — device-code flow
// ---------------------------------------------------------------------------

/**
 * Pairing is a device-code exchange, not a pasted secret
 * ({@link MUSTS.PAIR_INTERACTIVE}). The daemon starts a pairing, shows the
 * user a short code and a URL, and polls until the user approves it inside
 * the app's own authenticated session. Nothing listens on the user's machine
 * and nothing works over a copied string alone.
 */
export const PairStartRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    action: z.literal("start"),
    daemon: z.object({
      version: z.string().min(1),
      /** Shown in the app's runner list so a user can tell their machines apart. */
      label: z.string().min(1).max(120),
      platform: z.enum(["darwin", "linux", "win32"]),
    }),
    /**
     * This machine's public keys (byollm_009 §5).
     *
     * Pairing is where the two parties learn each other's identities, because
     * it is the one moment a human is already deciding to trust: the approval
     * click. A key exchanged anywhere else would be a key nobody chose.
     */
    device: PublicIdentity,
    capabilities: CapabilityMatrix,
  })
  .strict();
export type PairStartRequest = z.infer<typeof PairStartRequest>;

export const PairStartResponse = z
  .object({
    /** Secret the daemon polls with. Never shown to the user. */
    deviceCode: z.string().min(20),
    /** Short code the user reads and confirms in the browser. */
    userCode: z.string().min(4).max(16),
    /** Where the user approves. Must be on the server's own origin. */
    verificationUrl: z.url(),
    /** Epoch ms after which the code is dead ({@link MUSTS.PAIR_CODE_EXPIRES}). */
    expiresAt: z.number().int().positive(),
    /** How often the daemon may poll. */
    pollIntervalMs: z.number().int().min(500).max(60_000),
  })
  .strict();
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairPollRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    action: z.literal("poll"),
    deviceCode: z.string().min(20),
  })
  .strict();
export type PairPollRequest = z.infer<typeof PairPollRequest>;

export const PairPollResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z
    .object({
      status: z.literal("approved"),
      /** Bearer token for every later call. Scoped to exactly one user. */
      runnerToken: z.string().min(20),
      runnerId: z.string().min(1),
      /** The app's id for the approving user — this daemon's owner forever. */
      owner: z.string().min(1),
      /** Display name for the trust UI, if the app offers one. */
      ownerLabel: z.string().optional(),
      /**
       * The site's public keys, for the daemon to pin (byollm_009 §5).
       *
       * Returned only on approval — a pending or denied poll learns nothing,
       * so an unapproved code cannot be used to enumerate a site's keys.
       */
      site: PublicIdentity,
    })
    .strict(),
]);
export type PairPollResponse = z.infer<typeof PairPollResponse>;

export const PairRequest = z.discriminatedUnion("action", [
  PairStartRequest,
  PairPollRequest,
]);
export type PairRequest = z.infer<typeof PairRequest>;

// ---------------------------------------------------------------------------
// 2. POST /byollm/claim
// ---------------------------------------------------------------------------

export const ClaimRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    /** Re-sent on every claim so a server never matches against a stale matrix. */
    capabilities: CapabilityMatrix,
    /** Upper bound on jobs to return; the server may return fewer. */
    max: z.number().int().min(1).max(64),
  })
  .strict();
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const ClaimResponse = z
  .object({
    jobs: z.array(ClaimedJob),
    /** Lease duration granted, so the daemon knows its renewal deadline. */
    leaseMs: z.number().int().positive(),
  })
  .strict();
export type ClaimResponse = z.infer<typeof ClaimResponse>;

// ---------------------------------------------------------------------------
// 3. POST /byollm/heartbeat
// ---------------------------------------------------------------------------

export const HeartbeatRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    daemonVersion: z.string().min(1),
    capabilities: CapabilityMatrix,
    /**
     * Leases this daemon believes it holds; the server renews exactly these.
     *
     * Lease ids rather than job ids, so a replayed heartbeat cannot renew a
     * grant the runner no longer holds — see {@link Lease.id}.
     */
    activeLeases: z.array(
      z.object({ jobId: z.string().min(1), leaseId: z.string().min(1) }),
    ),
    /** True while the owner has the daemon paused; the server stops offering work. */
    paused: z.boolean(),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z
  .object({
    /** Once true, the daemon stops claiming and abandons in-flight work. */
    revoked: z.boolean(),
    /**
     * Per-job cancel (byollm_001 Rev 1 §C). The daemon aborts these jobs'
     * in-flight backend calls and reports them `canceled`.
     */
    cancel: z.array(z.string().min(1)),
    /** Jobs whose leases were renewed, with their new expiry. */
    leases: z.array(
      z
        .object({
          jobId: z.string().min(1),
          expiresAt: z.number().int().positive(),
        })
        .strict(),
    ),
    /**
     * Jobs the daemon thinks it holds but the server has reassigned or
     * expired. The daemon must stop work on these and not report results.
     */
    lost: z.array(z.string().min(1)),
    /** Server clock, so a daemon with a skewed clock still honors leases. */
    serverTime: z.number().int().positive(),
  })
  .strict();
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ---------------------------------------------------------------------------
// 4. POST /byollm/result
// ---------------------------------------------------------------------------

export const ResultRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    jobId: z.string().min(1),
    outcome: JobOutcome,
    /** Which model actually served it, for the result's provenance. */
    model: z.string().min(1),
    backendClass: BackendClass,
    /** Wall-clock milliseconds the backend call took. */
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type ResultRequest = z.infer<typeof ResultRequest>;

export const ResultResponse = z
  .object({
    /**
     * False when the submission lost an idempotency race or the lease was
     * already gone — the daemon should discard, not retry
     * ({@link MUSTS.RESULT_IDEMPOTENT}).
     */
    accepted: z.boolean(),
    /** The job's state after this submission. */
    state: z.string().min(1),
  })
  .strict();
export type ResultResponse = z.infer<typeof ResultResponse>;

// ---------------------------------------------------------------------------
// 5. POST /byollm/release
// ---------------------------------------------------------------------------

export const ReleaseRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    /**
     * Which leases to release — the grant, not just the job.
     *
     * A release naming only a job id releases whatever lease exists at the
     * moment it arrives, which for a replayed request is not the lease the
     * daemon meant. See {@link Lease.id}.
     */
    leases: z.array(
      z.object({ jobId: z.string().min(1), leaseId: z.string().min(1) }),
    ),
    /**
     * Why, so the app's runner list can say something true.
     *
     * `refused` is load-bearing, not cosmetic: the server cannot evaluate a
     * daemon's *local* `named` allowlist (§4.2), so it may legitimately offer
     * a job this daemon then declines. The server MUST record the refusal and
     * stop offering that job to that runner, or the pair would spin between
     * claim and release forever.
     */
    reason: z.enum(["shutdown", "pause", "revoked", "backend-down", "refused"]),
  })
  .strict();
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;

export const ReleaseResponse = z
  .object({
    released: z.array(z.string().min(1)),
  })
  .strict();
export type ReleaseResponse = z.infer<typeof ReleaseResponse>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Wire error codes.
 *
 * byollm_002 requires that "server unreachable", "revoked", "no matching
 * work" and "backend down" never share a message. Distinct codes here are how
 * the daemon can tell three of those apart; the fourth is a transport failure
 * with no response at all.
 */
export const WireErrorCode = z.enum([
  "bad-request",
  "unsupported-protocol-version",
  "unauthorized",
  "revoked",
  "not-found",
  "rate-limited",
  "server-error",
]);
export type WireErrorCode = z.infer<typeof WireErrorCode>;

export const WireError = z
  .object({
    error: WireErrorCode,
    message: z.string().min(1),
    /** Seconds; mirrors Retry-After for `rate-limited` and `server-error`. */
    retryAfter: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WireError = z.infer<typeof WireError>;

/** HTTP status each error code is served with. */
export const ERROR_STATUS: Readonly<Record<WireErrorCode, number>> =
  Object.freeze({
    "bad-request": 400,
    "unsupported-protocol-version": 400,
    unauthorized: 401,
    revoked: 403,
    "not-found": 404,
    "rate-limited": 429,
    "server-error": 500,
  });
