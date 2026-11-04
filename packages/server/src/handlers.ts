import { openSealedOutcome } from "./sealed-outcome.js";
import {
  BlobSlotRequest,
  BlobSlotResponse,
  BlobUrlRequest,
  BlobUrlResponse,
  isBlobObjectSize,
  FetchRequest,
  type ImageJobOutcome,
  type ImageSealedOutcome,
  type JobOutcome,
  type SealedOutcome,
  keyId,
  open,
  publicIdentityOf,
  FetchResponse,
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
  TOOL_LIMITS,
  ToolCallRequest,
  ToolCallResponse,
  ToolResultsRequest,
  ToolResultsResponse,
  provenanceFor,
  type ClaimResponse,
  type Endpoint,
  type HeartbeatResponse,
  PairPollResponse,
  type PairStartResponse,
  type ReleaseResponse,
  type ResultResponse,
  type WireErrorCode,
} from "@byollm/protocol";
import {
  BLOB_URL_SEGMENT,
  BLOB_URL_TTL_MS,
  BLOBS_KEPT_AFTER_DEADLINE_MS,
  blobFault,
  openBlobUrl,
  outputBlobIds,
  servable,
  signBlobUrl,
  wrapBlobKey,
} from "./blobs.js";
import { generateDeviceCode, generateUserCode, hashSecret } from "./ids.js";
import { resealForDevice } from "./reseal.js";
import { deadlineFor } from "./records.js";
import type { JobRecord, RunnerRecord, StoredOutcome } from "./records.js";
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
  /**
   * The absolute URL this mount serves, `<origin><basePath>` — where blob
   * URLs point (byollm_021 §2). A transport that cannot say leaves it out,
   * and the two blob endpoints refuse rather than mint a URL to nowhere.
   */
  readonly mountUrl?: string;
}

/** A blob served or stored by URL — what a transport turns into a response. */
export type BlobTransfer =
  | { readonly status: 200; readonly bytes: Uint8Array }
  | { readonly status: 204 }
  | { readonly status: 404 | 409 | 413 };

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
 * The protocol endpoints, over any {@link ByollmStore}: byollm_001's five,
 * `fetch`, and byollm_012 §5.2's two daemon-plane tool endpoints.
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
  /** This site's identity key id — Amendment A's `stub.site`. Derived once. */
  readonly #siteKeyId: string;

  constructor(config: HandlerConfig) {
    this.#store = config.store;
    // Fail at construction, not at the first pairing. A site whose keys are
    // malformed should not start and then refuse its users one at a time.
    if (!verifyPublicIdentity(publicIdentityOf(config.siteKeys))) {
      throw new Error(
        "siteKeys are not internally consistent: the encryption key is not " +
          "signed by the identity key. Generate a fresh pair with " +
          "`npx --package @byollm/server keygen`.",
      );
    }
    this.#siteKeys = config.siteKeys;
    this.#siteKeyId = keyId(publicIdentityOf(config.siteKeys).identity);
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
        // Heartbeat is the channel revocation travels on — and since V1-2 it
        // travels as the refusal itself ({@link MUSTS.REVOCATION_HONORED}).
        //
        // It used to be answered with an empty site set, which the daemon
        // read as "revoked". That reading is gone: an empty set now means
        // "nothing is consented right now", because a projection can arrive
        // empty by accident and the daemon's response to revocation is to
        // delete its pairing. So the one call every daemon always makes — a
        // daemon with no working backend never claims — carries the
        // unambiguous version: 403 with `revoked`, which is a code and not an
        // inference.
        return this.#authed(
          auth,
          body,
          HeartbeatRequest,
          this.#heartbeat.bind(this),
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
      case "tool-call":
        return this.#authed(
          auth,
          body,
          ToolCallRequest,
          this.#toolCall.bind(this),
        );
      case "tool-results":
        return this.#authed(
          auth,
          body,
          ToolResultsRequest,
          this.#toolResults.bind(this),
        );
      case "blob-url":
        return this.#authed(auth, body, BlobUrlRequest, (request, runner) =>
          this.#blobUrl(request, runner, auth.mountUrl),
        );
      case "blob-slot":
        return this.#authed(auth, body, BlobSlotRequest, (request, runner) =>
          this.#blobSlot(request, runner, auth.mountUrl),
        );
    }
  }

  // -- blobs — byollm_021 §2 ---------------------------------------------

  /**
   * The job this runner holds under `leaseId`, or `null` — the lease scope
   * every blob call shares ({@link MUSTS.LEASE_SCOPED_BY_GRANT}).
   *
   * One answer for unknown, not yours and superseded, as `fetch` gives.
   */
  async #held(
    jobId: string,
    leaseId: string,
    runnerId: string,
  ): Promise<JobRecord | null> {
    const job = await this.#store.get(jobId);
    if (
      !job ||
      job.lease?.runnerId !== runnerId ||
      job.lease.id !== leaseId ||
      (job.state !== "claimed" && job.state !== "running")
    ) {
      return null;
    }
    return job;
  }

  /**
   * A download URL for one input blob of a job this runner holds.
   *
   * No lease, no URL: the URL is minted for this lease and dies with it, and
   * a blob that is not one of this job's stored inputs gets the same
   * `not-found` as a lease that is not held.
   */
  async #blobUrl(
    request: BlobUrlRequest,
    runner: RunnerRecord,
    mountUrl: string | undefined,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const now = this.#now();
    const job = await this.#held(request.jobId, request.leaseId, runner.id);
    const blob = job === null ? null : await this.#store.getBlob(request.blob);
    if (
      job === null ||
      blob?.jobId !== job.id ||
      blob.direction !== "in" ||
      blob.data === null ||
      blob.deleteAt <= now
    ) {
      return fail("not-found", "no such blob under a lease you hold");
    }
    if (mountUrl === undefined) {
      return fail("server-error", "this mount cannot serve blob URLs");
    }
    const expiresAt = now + BLOB_URL_TTL_MS;
    const token = signBlobUrl(this.#siteKeys, {
      blob: blob.id,
      jobId: job.id,
      leaseId: request.leaseId,
      method: "GET",
      expiresAt,
    });
    return ok(
      BlobUrlResponse.parse({
        url: `${mountUrl}/${BLOB_URL_SEGMENT}/${token}`,
        expiresAt,
      }),
    );
  }

  /**
   * An upload slot for one output image of an `llm.image` job this runner
   * holds.
   *
   * The slot is issued for exactly `bytes`, which must be a size an object
   * can have (whole padding buckets plus overhead), and at most
   * {@link MAX_IMAGES_OUT} are issued under one lease. It is written as a
   * row with no bytes and a deletion time of the job's deadline plus a day,
   * so a slot the device never fills goes with the job like any blob.
   */
  async #blobSlot(
    request: BlobSlotRequest,
    runner: RunnerRecord,
    mountUrl: string | undefined,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const now = this.#now();
    const job = await this.#held(request.jobId, request.leaseId, runner.id);
    if (job === null) {
      return fail("not-found", "no such lease on this job");
    }
    if (job.kind !== "llm.image") {
      return fail("bad-request", "only an llm.image job uploads images");
    }
    if (!isBlobObjectSize(request.bytes)) {
      return fail(
        "bad-request",
        "a slot is whole 256 KiB buckets plus 40 bytes, up to one image at the cap",
      );
    }
    if (mountUrl === undefined) {
      return fail("server-error", "this mount cannot serve blob URLs");
    }
    let id: string | undefined;
    for (const candidate of outputBlobIds(
      this.#siteKeys,
      job.id,
      request.leaseId,
    )) {
      if ((await this.#store.getBlob(candidate)) === null) {
        id = candidate;
        break;
      }
    }
    if (id === undefined) {
      return fail(
        "bad-request",
        "this lease has been issued every output slot an llm.image job may use",
      );
    }
    await this.#store.putBlob({
      id,
      jobId: job.id,
      direction: "out",
      slotBytes: request.bytes,
      data: null,
      deleteAt: deadlineFor(job, now) + BLOBS_KEPT_AFTER_DEADLINE_MS,
      createdAt: now,
    });
    const expiresAt = now + BLOB_URL_TTL_MS;
    const token = signBlobUrl(this.#siteKeys, {
      blob: id,
      jobId: job.id,
      leaseId: request.leaseId,
      method: "PUT",
      expiresAt,
    });
    return ok(
      BlobSlotResponse.parse({
        blob: id,
        url: `${mountUrl}/${BLOB_URL_SEGMENT}/${token}`,
        expiresAt,
      }),
    );
  }

  /**
   * Serve one blob URL: `GET` an input's ciphertext, or `PUT` an output's.
   *
   * The token is this site's signature over one blob, one lease and one
   * method, and it expires; on top of that the lease it names must still be
   * the job's current one, so a URL dies the moment its grant does. A `PUT`
   * fills an empty slot once, and a body longer than the slot is refused
   * without being kept — reading stops one byte past it.
   */
  async transferBlob(input: {
    readonly token: string;
    readonly method: string;
    readonly body?: ReadableStream<Uint8Array> | null;
  }): Promise<BlobTransfer> {
    const now = this.#now();
    const grant = openBlobUrl(
      publicIdentityOf(this.#siteKeys).identity,
      input.token,
      now,
    );
    if (grant?.method !== input.method) return { status: 404 };
    const job = await this.#store.get(grant.jobId);
    if (
      job?.lease?.id !== grant.leaseId ||
      (job.state !== "claimed" && job.state !== "running")
    ) {
      return { status: 404 };
    }
    const blob = await this.#store.getBlob(grant.blob);
    if (blob === null) return { status: 404 };
    if (!servable(blob, grant, now)) {
      return { status: grant.method === "PUT" ? 409 : 404 };
    }
    if (grant.method === "GET") {
      return { status: 200, bytes: blob.data ?? new Uint8Array() };
    }
    const data = await readAtMost(input.body ?? null, blob.slotBytes);
    if (data === null) return { status: 413 };
    await this.#store.putBlob({ ...blob, data });
    return { status: 204 };
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
    // One implementation of open-and-reseal, shared with the cloud lane: the
    // deadline and key ids are bound into a signature, and two copies of a
    // bound value is the bug this codebase keeps finding.
    const resealed = await resealForDevice({
      siteKeys: this.#siteKeys,
      job: { id: job.id, envelope: job.envelope, createdAt: job.createdAt },
      device: runner.device,
    });
    if (!resealed.ok) {
      return fail("server-error", "this job's payload could not be opened");
    }
    /* Parsed where it is built — B304's law, ruled into standing orders by
       CW on 2026-09-19. `satisfies` excess-checks a fresh literal and checks
       NOTHING on a variable, and the line looks identical either way; a seal
       travelled for months under one. The only spelling for a wire shape is
       its own schema. */
    return ok(FetchResponse.parse({ envelope: resealed.envelope }));
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
        collected: false,
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
      return ok(PairPollResponse.parse({ status: "denied" }));
    }
    // Expiry is checked before approval state so a code approved after it
    // lapsed is still dead ({@link MUSTS.PAIR_CODE_EXPIRES}).
    if (pairing.expiresAt <= now && pairing.state === "pending") {
      return ok(PairPollResponse.parse({ status: "expired" }));
    }
    if (
      pairing.state === "approved" &&
      !pairing.collected &&
      pairing.runnerId !== null &&
      pairing.owner !== null
    ) {
      /**
       * Parsed, and it did not say `satisfies` — which is the gap in a lint
       * that bans the word.
       *
       * An annotated `const` excess-checks its literal exactly as `satisfies`
       * does, and stops checking for exactly the same reason the moment a
       * spread from a variable arrives. Same risk, different spelling, and
       * only one of the two is greppable. Converted here rather than left for
       * the rule to miss.
       */
      const response = PairPollResponse.parse({
        status: "approved",
        runnerId: pairing.runnerId,
        owner: pairing.owner,
        // Only on approval: a pending or denied poll learns nothing, so an
        // unapproved code cannot be used to enumerate a site's keys.
        //
        // One entry, because a direct site *is* one site — the same shape a
        // hub answers with rather than a special case (cloud_009 §5). The
        // daemon's lookup is one map read on every lane, which is what keeps
        // the two lanes one protocol.
        sites: { [this.#siteKeyId]: publicIdentityOf(this.#siteKeys) },
      });
      // Delivered exactly once — a replayed device code gets nothing.
      await this.#store.consumePairingToken(pairing.deviceCodeHash);
      return ok(response);
    }
    if (pairing.state === "approved") {
      return fail("not-found", "this pairing has already been collected");
    }
    return ok(PairPollResponse.parse({ status: "pending" }));
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
        // This site, named by its identity key id — Amendment A §A.3. The
        // daemon pinned this exact value at pairing, so it can check the stub
        // against the envelope it later opens rather than taking our word for
        // which site sent it. On this plane that is redundant, which is the
        // point: the direct and relayed stubs are the same shape, and a daemon
        // serving both cannot tell which upstream it is talking to.
        site: this.#siteKeyId,
        // byollm_016 Phase B. Present only when the site named one, and
        // omitted rather than sent as undefined — the stub is `.strict()` and
        // an explicit undefined is not the same as an absent key.
        ...(job.purpose === undefined ? {} : { purpose: job.purpose }),
        // Bucketed, not measured: an exact size is a stronger fingerprint
        // than routing needs (byollm_009 §6).
        sizeClass: job.sizeClass,
        // Reserved for byollm_006; no job declares it yet.
        streaming: false,
        // The stub's deadline bounds how long a captured envelope is worth
        // keeping, so it is always present — falling back to the TTL window
        // when the app named no absolute one.
        deadlineAt: deadlineFor(job, now),
        // `audienceAllow` is not sent — cloud_008 §0.2. The list stays on
        // `JobRecord`, where `claim` already filtered candidates with it; the
        // daemon's own allowlist is what decides `named` (byollm_001 Rev 1
        // §B) and always was.
        //
        // Removing it from `JobStub` did **not** make this line a type error.
        // A conditional spread is not excess-property-checked, so the field
        // would have gone on being sent to a daemon whose `.strict()` parse
        // now rejects the entire claim response — every daemon on the version
        // pair, refusing all work, for a field nobody read. Worth stating
        // where it happened: the schema is the contract, and the compiler
        // does not enforce it through a spread.
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
    // No revoked branch here any more — V1-2. A revoked runner is refused by
    // `#authed` before this handler is reached, on heartbeat as on every
    // other endpoint, because "revoked" and "nothing consented right now"
    // must not arrive as the same empty body.

    await this.#store.touchRunner({
      runnerId: runner.id,
      capabilities: request.capabilities,
      daemonVersion: request.daemonVersion,
      now,
    });

    // `renewed` is not reported back — cloud_008 §1.4b. The grants are still
    // extended; the daemon simply never read the list, and `lost` is the
    // signal it acts on.
    const { lost } = await this.#store.renewLeases({
      runnerId: runner.id,
      leases: request.activeLeases,
      leaseMs: this.#leaseMs,
      now,
    });

    const cancel = await this.#store.listCancelRequests(runner.id);

    const response: HeartbeatResponse = {
      sites: { [this.#siteKeyId]: publicIdentityOf(this.#siteKeys) },
      // A direct site has no disclosure of its own to go stale: consent to it
      // *is* the pairing, and withdrawing it empties the set above.
      awaitingConsent: [],
      cancel: [...cancel],
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

    const outcome = await this.#openResult(request, runner, job);
    if (!outcome.ok) return outcome.failure;
    const stored = await this.#storedOutcome(job, outcome.value.outcome, now);
    if (!stored.ok) return stored.failure;

    // Provenance is built here, from the job's audience and the authenticated
    // runner — never from anything the daemon asserted
    // ({@link MUSTS.PROVENANCE_NAMES_DEVICE}).
    const provenance = provenanceFor({
      audience: job.audience,
      runnerId: runner.id,
      runnerOwner: runner.owner,
      // From the envelope the device signed, not from the request beside it
      // — cloud_008 §2.5. A daemon can no longer seal one answer and declare
      // it came from a different model.
      backendClass: outcome.value.ran.backendClass,
      model: outcome.value.ran.model,
      /* Why it stopped, and whether the adapter could tell — B260. Sealed by
         the device and dropped here until Kevin's team found a `length`
         result arriving indistinguishable from a complete one. */
      ...(outcome.value.ran.stop === undefined
        ? {}
        : { stop: outcome.value.ran.stop }),
      ...(outcome.value.ran.stopReported === undefined
        ? {}
        : { stopReported: outcome.value.ran.stopReported }),
    });

    const {
      accepted,
      duplicate,
      job: updated,
    } = await this.#store.complete({
      jobId: request.jobId,
      // Who is asking, for the duplicate answer only — §3.6. Authorisation
      // is `holder`, below, and still is.
      runnerId: runner.id,
      // The grant, not the runner — cloud_008 §1.4a. `CompleteHolder`'s own
      // docstring already called the lease "the more exact check anyway";
      // this plane simply had no lease id to give it until now.
      holder: { by: "lease", leaseId: request.leaseId },
      outcome: stored.outcome,
      provenance,
      now,
    });

    // byollm_021 §2: input blobs go when the result is accepted — nothing
    // reads them after that. Only on acceptance: a refused or duplicate
    // result leaves them for the device the job may still be offered to.
    if (accepted && job.kind === "llm.vision") {
      await this.#store.deleteBlob({
        jobId: job.id,
        direction: "in",
        notAfter: now,
        now,
      });
    }

    const response: ResultResponse = {
      accepted,
      // Only when true — cloud_008 §3.6. Absent means "not a duplicate", and
      // an optional field that is always present is a required one wearing a
      // question mark.
      ...(duplicate === true ? { duplicate: true } : {}),
      state: updated?.state ?? job.state,
    };
    return ok(response);
  }

  /**
   * Open a sealed result, or refuse it.
   *
   * The mirror of the daemon's `#openPayload`, and refuses for the same
   * reason: an outcome that does not verify against the device's pinned key is
   * an assertion by whoever relayed it, and storing it would let an
   * intermediary write answers into the app.
   *
   * The clear-text `disposition` is checked here rather than trusted. It is on
   * the wire so a relay can route without opening anything, which means the
   * one thing it must not be is authoritative — a daemon that sealed an error
   * and declared `ok` would otherwise have its declaration believed by
   * everything upstream of this line.
   */
  async #openResult(
    request: ResultRequestType,
    runner: RunnerRecord,
    job: JobRecord,
  ): Promise<
    | { ok: true; value: SealedOutcome | ImageSealedOutcome }
    | { ok: false; failure: HandlerResult }
  > {
    const refuse = (why: string) =>
      ({ ok: false as const, failure: fail("bad-request", why) }) as const;

    const opened = await open({
      envelope: request.envelope,
      recipientKeys: this.#siteKeys,
      senderIdentityPublic: runner.device.identity,
      expected: {
        jobId: request.jobId,
        senderKeyId: keyId(runner.device.identity),
        recipientKeyId: keyId(publicIdentityOf(this.#siteKeys).identity),
        direction: "result",
      },
    });
    if (!opened.ok) {
      return refuse("the result did not verify as coming from this device");
    }

    /* One function, both lanes — see `sealed-outcome.ts`. The refusal
       messages are the ones this lane already returned, now stated once. */
    const outcome = openSealedOutcome({
      plaintext: opened.plaintext,
      disposition: request.disposition,
      kind: job.kind,
    });
    if (!outcome.ok) return refuse(outcome.why);
    return { ok: true, value: outcome.value };
  }

  // -- 6. tool-call and tool-results — byollm_012 §5.2 ----------------------
  //
  // The daemon's two tool endpoints, on the site's own handlers. The site is
  // the upstream on this lane, so the call it records is the one its own
  // pump answers through `ByollmApp.calls` and `ByollmApp.toolResult` — one
  // shape on both lanes, with nothing in between.

  async #toolCall(
    request: ToolCallRequest,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const recorded = await this.#store.recordToolCall({
      jobId: request.jobId,
      runnerId: runner.id,
      leaseId: request.leaseId,
      callId: request.callId,
      envelope: request.envelope,
      // The protocol ceiling. The job's own budget is the site SDK's count
      // on this lane (byollm_012 §8, C040); the store's is the backstop.
      maxToolCalls: TOOL_LIMITS.maxToolCalls,
      timeoutMs: TOOL_LIMITS.callTimeoutMs,
      now: this.#now(),
    });
    if ("refused" in recorded) {
      switch (recorded.refused) {
        case "not-found":
          // One answer for unknown, not yours and stale, as `fetch` gives.
          return fail("not-found", "no such lease on this job");
        case "not-tools":
          return fail("bad-request", "this job does not carry tools");
        case "budget":
          return fail(
            "forbidden",
            "this job has made every tool call it is allowed",
          );
        case "call-conflict":
          return fail(
            "bad-request",
            "that call id already names a different call",
          );
      }
    }
    return ok(
      ToolCallResponse.parse({
        callId: recorded.recorded.callId,
        expiresAt: recorded.recorded.expiresAt,
      }),
    );
  }

  async #toolResults(
    request: ToolResultsRequest,
    runner: RunnerRecord,
  ): Promise<HandlerResult> {
    if (request.runnerId !== runner.id) {
      return fail("unauthorized", "runner id does not match the signing key");
    }
    const answered = await this.#store.toolResults({
      runnerId: runner.id,
      calls: request.calls,
    });
    return ok(
      ToolResultsResponse.parse({
        results: answered.map((row) => ({
          jobId: row.jobId,
          leaseId: row.leaseId,
          callId: row.callId,
          envelope: row.result,
        })),
      }),
    );
  }

  /**
   * The outcome as this site keeps it — byollm_021 §2.
   *
   * A text answer is kept as sealed. An `llm.image` answer's references are
   * checked first: every output blob must be stored, this job's, and exactly
   * the size its slot was issued for, which is the declared size — the same
   * check an input gets before its job is offered. Then each key is wrapped,
   * so the store keeps the references and nothing that opens them.
   */
  async #storedOutcome(
    job: JobRecord,
    outcome: JobOutcome | ImageJobOutcome,
    now: number,
  ): Promise<
    { ok: true; outcome: StoredOutcome } | { ok: false; failure: HandlerResult }
  > {
    if (!("images" in outcome)) return { ok: true, outcome };
    for (const ref of outcome.images) {
      const fault = await blobFault(this.#store, {
        jobId: job.id,
        direction: "out",
        ref,
        now,
      });
      if (fault !== null) {
        return { ok: false, failure: fail("bad-request", fault) };
      }
    }
    return {
      ok: true,
      outcome: {
        outcome: "ok",
        text: outcome.text,
        images: outcome.images.map(({ key, ...ref }) => ({
          ...ref,
          wrappedKey: wrapBlobKey(this.#siteKeys, job.id, ref.blob, key),
        })),
      },
    };
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

/**
 * Read a body, or `null` once it runs past `limit` bytes.
 *
 * Stops reading at the first byte over, so a device cannot make this
 * process hold more than one slot's worth of anybody's upload.
 */
async function readAtMost(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
