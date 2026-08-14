import {
  FetchRequest,
  keyId,
  open,
  publicIdentityOf,
  type FetchResponse,
  RequestSignature,
  verifyRequest,
  verifyPublicIdentity,
  type StoredKeys,
  ClaimRequest,
  type ClaimRequest as ClaimRequestType,
  type HeartbeatRequest as HeartbeatRequestType,
  type ReleaseRequest as ReleaseRequestType,
  type ResultRequest as ResultRequestType,
  ERROR_STATUS,
  HeartbeatRequest,
  PairRequest,
  PROTOCOL_VERSION,
  ReleaseRequest,
  ResultRequest,
  provenanceFor,
  type ClaimResponse,
  type Endpoint,
  type HeartbeatResponse,
  type PairPollResponse,
  type PairStartResponse,
  type ReleaseResponse,
  type ResultResponse,
  type WireErrorCode,
} from "@byollm/protocol";
import { generateDeviceCode, generateUserCode, hashSecret } from "./ids.js";
import type { JobRecord, RunnerRecord } from "./records.js";
import type { ByollmStore } from "./store.js";

/** Everything a mount needs to serve the protocol. */
/**
 * What a transport must hand the handler to authenticate a call.
 *
 * `rawBody` is the exact bytes received, not a re-serialisation of the parsed
 * object: JSON.stringify does not round-trip byte-for-byte, and a signature
 * over re-serialised input verifies something the sender never signed.
 */
export interface AuthContext {
  readonly endpoint: string;
  readonly rawBody: string;
  readonly signature: unknown;
}

export interface HandlerConfig {
  readonly store: ByollmStore;
  /**
   * Absolute URL of the page where a user approves a pairing. The device code
   * is *not* appended — the user types the short code into the app's own
   * authenticated page, which is what keeps pairing interactive.
   */
  readonly verificationUrl: string;
  /** How long a lease lasts. Default 60s — six heartbeats of headroom. */
  readonly leaseMs?: number;
  /** How long an unapproved pairing code lives. Default 10 minutes. */
  readonly pairingTtlMs?: number;
  /** How often a daemon may poll for pairing approval. Default 2s. */
  readonly pollIntervalMs?: number;
  /** Injectable clock, so tests can move time without sleeping. */
  readonly now?: () => number;
  /**
   * This site's keypairs (byollm_009 §5) — **supplied, never generated here.**
   *
   * A site is usually more than one process. Generating keys at startup would
   * work perfectly in development and fail only in production, silently: each
   * instance would have a different identity, a daemon would pin whichever
   * one approved its pairing, and every request routed to a different
   * instance would fail a signature check it had no way to explain. So this
   * is a required input, and there is a `keygen` script that produces one.
   */
  readonly siteKeys: StoredKeys;
}

const DEFAULTS = {
  leaseMs: 60_000,
  pairingTtlMs: 10 * 60_000,
  pollIntervalMs: 2_000,
} as const;

/** A handled protocol call: a status and a JSON body. */
export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
  /** Set for `rate-limited` and `server-error`. */
  readonly retryAfterSeconds?: number;
}

function fail(
  error: WireErrorCode,
  message: string,
  retryAfterSeconds?: number,
): HandlerResult {
  return {
    status: ERROR_STATUS[error],
    body: {
      error,
      message,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retryAfter: retryAfterSeconds }),
    },
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function ok(body: unknown): HandlerResult {
  return { status: 200, body };
}

/**
 * The five protocol endpoints, over any {@link ByollmStore}.
 *
 * Transport-free on purpose: a mount adapts `Request`/`Response` (or Express,
 * or whatever) onto {@link ByollmHandlers.handle}, and everything the
 * protocol actually specifies lives here where the conformance kit can reach
 * it without an HTTP server in the way.
 */
export class ByollmHandlers {
  readonly #store: ByollmStore;
  readonly #verificationUrl: string;
  readonly #leaseMs: number;
  readonly #pairingTtlMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #siteKeys: StoredKeys;

  constructor(config: HandlerConfig) {
    this.#store = config.store;
    // Fail at construction, not at the first pairing. A site whose keys are
    // malformed should not start and then refuse its users one at a time.
    if (!verifyPublicIdentity(publicIdentityOf(config.siteKeys))) {
      throw new Error(
        "siteKeys are not internally consistent: the encryption key is not " +
          "signed by the identity key. Generate a fresh pair with " +
          "`npx @byollm/server keygen`.",
      );
    }
    this.#siteKeys = config.siteKeys;
    this.#verificationUrl = config.verificationUrl;
    this.#leaseMs = config.leaseMs ?? DEFAULTS.leaseMs;
    this.#pairingTtlMs = config.pairingTtlMs ?? DEFAULTS.pairingTtlMs;
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.#now = config.now ?? Date.now;
  }

  /**
   * Dispatch one protocol call.
   *
   * @param endpoint - which of the five, already routed from the path
   * @param body - the parsed JSON request body, untrusted
   * @param auth - the signature and the exact bytes it covers
   */
  async handle(
    endpoint: Endpoint,
    body: unknown,
    auth: AuthContext,
  ): Promise<HandlerResult> {
    switch (endpoint) {
      case "pair":
        return this.#pair(body);
      case "claim":
        return this.#authed(auth, body, ClaimRequest, this.#claim.bind(this));
      case "heartbeat":
        // Heartbeat is the channel revocation travels on, so a revoked runner
        // must reach the handler and be told `revoked: true` rather than be
        // bounced with a 403 it would treat as a transport problem
        // ({@link MUSTS.REVOCATION_HONORED}).
        return this.#authed(
          auth,
          body,
          HeartbeatRequest,
          this.#heartbeat.bind(this),
          { allowRevoked: true },
        );
      case "fetch":
        return this.#authed(auth, body, FetchRequest, this.#fetch.bind(this));
      case "result":
        return this.#authed(auth, body, ResultRequest, this.#result.bind(this));
      case "release":
        return this.#authed(
          auth,
          body,
          ReleaseRequest,
          this.#release.bind(this),
        );
    }
  }

  /**
   * Shared preamble for the four authenticated endpoints: verify the
   * signature, reject a revoked runner, and parse the body.
   *
   * Authentication happens before schema validation so a stranger probing the
   * endpoint learns nothing about the wire format.
   */
  async #authed<T>(
    auth: AuthContext,
    body: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    run: (request: T, runner: RunnerRecord) => Promise<HandlerResult>,
    options: { allowRevoked?: boolean } = {},
  ): Promise<HandlerResult> {
    const signature = RequestSignature.safeParse(auth.signature);
    if (!signature.success) {
      return fail("unauthorized", "this request is not signed");
    }

    const runner = await this.#store.getRunner(signature.data.runnerId);
    if (!runner) {
      return fail("unauthorized", "this runner is not recognised");
    }

    // Verified against the identity pinned when the user approved this
    // machine — not against anything the request carries. A signature that
    // authenticates itself authenticates nothing.
    const failure = verifyRequest({
      identityPublic: runner.device.identity,
      endpoint: auth.endpoint,
      body: auth.rawBody,
      signature: signature.data,
      now: this.#now(),
    });
    if (failure !== null) {
      // Deliberately one message for both causes. Telling a caller whether
      // their clock or their key is wrong tells an attacker which half of a
      // forgery already works.
      return fail("unauthorized", "this request's signature is not valid");
    }
    if (runner.revokedAt !== null && options.allowRevoked !== true) {
      // A distinct truth from "unauthorized": the daemon should stop and say
      // so, not retry or re-pair silently.
      return fail("revoked", "this runner has been revoked by its owner");
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      return fail("bad-request", "request body failed schema validation");
    }
    return run(parsed.data, runner);
  }

  /**
   * Hand over the payload for a lease this runner holds — byollm_009 §6.
   *
   * The second half of claim-then-fetch. A claim answers with a stub, and the
   * work itself is collected separately by the device that took it, because a
   * payload can only be sealed once its recipient is known.
   *
   * Scoped to the lease, not the job: answering for whatever lease happens to
   * exist would hand the work to a runner whose grant had already been
   * superseded.
   */
  async #fetch(
    request: FetchRequest,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    const job = await this.#store.get(request.jobId);
    if (
      !job ||
      job.lease?.runnerId !== runner.id ||
      job.lease.id !== request.leaseId
    ) {
      // One answer for "no such job", "not yours" and "a lease you no longer
      // hold". A caller who is allowed to know already knows which.
      return fail("not-found", "no such lease on this job");
    }
    // Opened here, with the site's own key: the store held ciphertext, and
    // this is the endpoint that is entitled to read it. byollm_009 §6 seals
    // it again to the claiming device; until that lands the plaintext travels
    // as it always did, over the same transport, to a runner that has already
    // proved possession of its key.
    const senderKeyId = keyId(publicIdentityOf(this.#siteKeys).identity);
    const opened = await open({
      envelope: job.envelope,
      recipientKeys: this.#siteKeys,
      senderIdentityPublic: this.#siteKeys.identityPublic,
      expected: {
        jobId: job.id,
        senderKeyId,
        recipientKeyId: senderKeyId,
        direction: "payload",
      },
    });
    if (!opened.ok) {
      // The store holds something this site cannot open: rotated keys, a
      // corrupted row, or someone else's envelope. Not the runner's problem
      // and not something a retry fixes.
      return fail("server-error", "this job's payload could not be opened");
    }
    return ok({
      payload: JSON.parse(opened.plaintext) as FetchResponse["payload"],
    } satisfies FetchResponse);
  }

  // -- 1. pair --------------------------------------------------------------

  async #pair(body: unknown): Promise<HandlerResult> {
    const parsed = PairRequest.safeParse(body);
    if (!parsed.success) {
      return fail("bad-request", "pair request failed schema validation");
    }
    const request = parsed.data;
    const now = this.#now();

    if (request.action === "start") {
      const deviceCode = generateDeviceCode();
      const userCode = generateUserCode();
      const expiresAt = now + this.#pairingTtlMs;

      // The machine must prove its encryption key belongs to the identity it
      // is presenting, before either is stored. Otherwise a caller could pair
      // a real identity with an encryption key it holds the secret for, and
      // read everything later sealed to that runner.
      if (!verifyPublicIdentity(request.device)) {
        return fail(
          "bad-request",
          "the device's encryption key is not signed by the identity it was presented with",
        );
      }

      await this.#store.createPairing({
        device: request.device,
        deviceCodeHash: hashSecret(deviceCode),
        userCode,
        state: "pending",
        owner: null,
        runnerId: null,
        runnerTokenOnce: null,
        label: request.daemon.label,
        platform: request.daemon.platform,
        daemonVersion: request.daemon.version,
        capabilities: request.capabilities,
        expiresAt,
        createdAt: now,
      });

      const response: PairStartResponse = {
        deviceCode,
        userCode,
        verificationUrl: this.#verificationUrl,
        expiresAt,
        pollIntervalMs: this.#pollIntervalMs,
      };
      return ok(response);
    }

    // action === "poll"
    const pairing = await this.#store.getPairingByDeviceCodeHash(
      hashSecret(request.deviceCode),
    );
    if (!pairing) {
      return fail("not-found", "unknown device code");
    }
    if (pairing.state === "denied") {
      return ok({ status: "denied" } satisfies PairPollResponse);
    }
    // Expiry is checked before approval state so a code approved after it
    // lapsed is still dead ({@link MUSTS.PAIR_CODE_EXPIRES}).
    if (pairing.expiresAt <= now && pairing.state === "pending") {
      return ok({ status: "expired" } satisfies PairPollResponse);
    }
    if (
      pairing.state === "approved" &&
      pairing.runnerTokenOnce !== null &&
      pairing.runnerId !== null &&
      pairing.owner !== null
    ) {
      const response: PairPollResponse = {
        status: "approved",
        runnerToken: pairing.runnerTokenOnce,
        runnerId: pairing.runnerId,
        owner: pairing.owner,
        // Only on approval: a pending or denied poll learns nothing, so an
        // unapproved code cannot be used to enumerate a site's keys.
        site: publicIdentityOf(this.#siteKeys),
      };
      // Delivered exactly once — a replayed device code gets nothing.
      await this.#store.consumePairingToken(pairing.deviceCodeHash);
      return ok(response);
    }
    if (pairing.state === "approved") {
      return fail("not-found", "this pairing has already been collected");
    }
    return ok({ status: "pending" } satisfies PairPollResponse);
  }

  // -- 2. claim -------------------------------------------------------------

  async #claim(
    request: ClaimRequestType,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const now = this.#now();

    // Capabilities from *this* request, never the stored matrix — a daemon
    // that just lost a backend must not be handed work for it
    // ({@link MUSTS.CLAIM_REQUIRES_CAPABILITY}).
    const jobs = await this.#store.claim({
      runnerId: runner.id,
      runnerOwner: runner.owner,
      capabilities: request.capabilities,
      max: request.max,
      leaseMs: this.#leaseMs,
      now,
    });

    const response: ClaimResponse = {
      jobs: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        audience: job.audience,
        owner: job.owner,
        // Bucketed, not measured: an exact size is a stronger fingerprint
        // than routing needs (byollm_009 §6).
        sizeClass: job.sizeClass,
        // Reserved for byollm_006; no job declares it yet.
        streaming: false,
        // The stub's deadline bounds how long a captured envelope is worth
        // keeping, so it is always present — falling back to the TTL window
        // when the app named no absolute one.
        deadlineAt: job.deadlineAt ?? (job.claimableAt ?? now) + job.ttlMs,
        ...(job.audienceAllow === undefined
          ? {}
          : { audienceAllow: [...job.audienceAllow] }),
        // No fallback. A job returned from `claim` holds a lease by
        // definition, and synthesising one here would hand the daemon a lease
        // id the store has never heard of — every later release naming it
        // would silently match nothing. A store that returns an unleased job
        // has broken its contract, and this says so.
        lease: leaseOf(job),
      })),
      leaseMs: this.#leaseMs,
    };
    return ok(response);
  }

  // -- 3. heartbeat ---------------------------------------------------------

  async #heartbeat(
    request: HeartbeatRequestType,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const now = this.#now();
    const revoked = runner.revokedAt !== null;

    if (revoked) {
      // Nothing is renewed for a revoked runner: every job it holds is
      // reported lost so it abandons the queue rather than finishing it.
      const held = await this.#store.listClaimedBy(runner.id);
      const response: HeartbeatResponse = {
        revoked: true,
        cancel: [],
        leases: [],
        lost: held.map((job) => job.id),
        serverTime: now,
      };
      return ok(response);
    }

    await this.#store.touchRunner({
      runnerId: runner.id,
      capabilities: request.capabilities,
      daemonVersion: request.daemonVersion,
      paused: request.paused,
      now,
    });

    const { renewed, lost } = await this.#store.renewLeases({
      runnerId: runner.id,
      leases: request.activeLeases,
      leaseMs: this.#leaseMs,
      now,
    });

    const cancel = await this.#store.listCancelRequests(runner.id);

    const response: HeartbeatResponse = {
      revoked: false,
      cancel,
      leases: renewed.map((r) => ({ jobId: r.jobId, expiresAt: r.expiresAt })),
      lost: [...lost],
      serverTime: now,
    };
    return ok(response);
  }

  // -- 4. result ------------------------------------------------------------

  async #result(
    request: ResultRequestType,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const now = this.#now();
    const job = await this.#store.get(request.jobId);
    if (!job) return fail("not-found", "unknown job");

    // Provenance is built here, from the job's audience and the authenticated
    // runner — never from anything the daemon asserted
    // ({@link MUSTS.RESULT_PROVENANCE}).
    const provenance = provenanceFor({
      audience: job.audience,
      runnerId: runner.id,
      runnerOwner: runner.owner,
      backendClass: request.backendClass,
      model: request.model,
    });

    const { accepted, job: updated } = await this.#store.complete({
      jobId: request.jobId,
      runnerId: runner.id,
      outcome: request.outcome,
      provenance,
      now,
    });

    const response: ResultResponse = {
      accepted,
      state: updated?.state ?? job.state,
    };
    return ok(response);
  }

  // -- 5. release -----------------------------------------------------------

  async #release(
    request: ReleaseRequestType,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const released = await this.#store.release({
      runnerId: runner.id,
      leases: request.leases,
      reason: request.reason,
      now: this.#now(),
    });
    const response: ReleaseResponse = { released };
    return ok(response);
  }
}

/** The protocol version this build speaks. */
export const SERVED_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** The lease a claimed job must have, or a loud failure. */
function leaseOf(job: JobRecord): NonNullable<JobRecord["lease"]> {
  if (!job.lease) {
    throw new Error(
      `store returned job ${job.id} from claim with no lease — the store ` +
        `contract requires a claimed job to hold one`,
    );
  }
  return job.lease;
}
