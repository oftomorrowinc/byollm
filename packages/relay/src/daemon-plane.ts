import {
  ClaimRequest,
  FetchRequest,
  HeartbeatRequest,
  PROTOCOL_VERSION,
  ReleaseRequest,
  ResultRequest,
  RequestSignature,
  keyId,
  verifyRequest,
  verifyPublicIdentity,
  PublicIdentity,
} from "@byollm/protocol";
import { z } from "zod";
import type { Projection } from "./fixture.js";
import type { HolderRefusal } from "./state.js";
import { clockSkewRefusal } from "./refusals.js";
import type { RoutingStore } from "./store.js";

/**
 * The plane a daemon talks to — cloud_004 §2.
 *
 * To a daemon this is an upstream like any other: it claims, fetches, reports
 * and heartbeats exactly as it does against a direct site. That sameness is
 * the point of §9's "the hub is a deployment of the open parts" — hub mode is
 * not a second daemon code path, it is a second upstream.
 *
 * What differs is invisible from the daemon's side and total from ours: **this
 * upstream cannot seal.** A direct site answers `fetch` by opening its own
 * envelope and re-sealing to the claiming device. The relay has nothing to
 * open and nothing to seal with, so it answers `fetch` with whatever the site
 * left for that device, or with nothing yet.
 */

export interface PlaneResult {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): PlaneResult => ({ status: 200, body });

/**
 * A store refusal, in HTTP.
 *
 * The store says *why* in its own vocabulary and this decides what a daemon is
 * told, which keeps the two independent: a store that grows a reason does not
 * get to invent a status code, and a status code that changes does not reach
 * into the store.
 *
 * `not-ready` is the one that matters. It means claimed-but-not-yet-sealed, and
 * a daemon must retry rather than abandon — the job is legitimately still
 * theirs until the lease or the awaiting-payload clock says otherwise. It was
 * the protocol gap that produced the 409 in the first place.
 */
const REFUSALS: Record<HolderRefusal, PlaneResult> = {
  "not-found": {
    status: 404,
    body: { error: "not-found", message: "unknown job" },
  },
  "not-holder": {
    status: 403,
    body: {
      error: "unauthorized",
      message: "this runner does not hold the job",
    },
  },
  "stale-lease": {
    status: 403,
    body: { error: "unauthorized", message: "that lease is no longer current" },
  },
  "not-ready": {
    status: 409,
    body: {
      error: "not-ready",
      message: "the site has not sealed this job yet",
    },
  },
};
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

export interface DaemonPlaneDeps {
  readonly state: RoutingStore;
  readonly projection: Projection;
  readonly now: () => number;
  readonly leaseMs: number;
  /**
   * Which site this relay routes for.
   *
   * The skeleton relays for one site because that is all the freeze gate
   * needs. The production hub's multi-tenant router is the closed piece that
   * replaces this field (cloud_004 §9) — recorded here so the seam is visible
   * rather than assumed away.
   */
  readonly siteId: string;
}

export class DaemonPlane {
  readonly #deps: DaemonPlaneDeps;

  constructor(deps: DaemonPlaneDeps) {
    this.#deps = deps;
  }

  /**
   * Pair a device — cloud_004 §3, the key-exchange moment.
   *
   * The relay hands back **the site's** public identity, taken from the
   * consent projection, not its own. This is the sentence that makes hub mode
   * safe: the daemon pins the party that will actually seal its work, so an
   * envelope is verified against the site even though it arrived via us. A
   * relay that substituted its own identity here could inject work — and would
   * need a private key to do it, which is why it has none.
   */
  async pair(body: unknown): Promise<PlaneResult> {
    const parsed = PairFixtureRequest.safeParse(body);
    if (!parsed.success) {
      return fail(400, "bad-request", "pair request failed schema validation");
    }
    if (!verifyPublicIdentity(parsed.data.device)) {
      return fail(400, "bad-request", "the device identity is not consistent");
    }

    const consent = this.#deps.projection.consentFor(
      parsed.data.owner,
      this.#deps.siteId,
    );
    if (!consent) {
      // CONSENT_BEFORE_ROUTE. There is no discovery path that creates one:
      // consent is a click somewhere else, and the relay only reads it.
      return fail(403, "forbidden", "no consent record for this user");
    }
    // The key comes from the site registry, which is its one home. It used to
    // be inlined on the consent record, which gave a site's key one copy per
    // consenting user and nothing to reconcile them against.
    const site = this.#deps.projection.siteFor(this.#deps.siteId);
    if (!site) {
      return fail(403, "forbidden", "this site is not registered");
    }

    // The device must already be approved, by a human, in the control plane.
    //
    // It presented keys; that is an assertion, not an identity. Somebody had
    // to look at a fingerprint and say yes, and this is where that decision is
    // enforced. byollm_009's seventh finding stopped a daemon from *naming*
    // itself and this stops it from *keying* itself — otherwise the relay
    // would be the authority on who a machine is, which is precisely the role
    // a blind relay must not hold.
    //
    // Matched on the identity key rather than a claimed id: the key is what
    // the human approved and what every later signature is checked against.
    const approved = this.#deps.projection.deviceByFingerprint(
      parsed.data.device.identity,
    );
    if (!approved) {
      return fail(
        403,
        "unauthorized",
        "this device has not been approved by its owner",
      );
    }
    if (approved.owner !== parsed.data.owner) {
      // The device was approved by somebody else. Refused rather than
      // re-owned: an approval is for a person, not a key in general.
      return fail(403, "forbidden", "this device belongs to another owner");
    }

    // The id comes from the control plane, not from the device and not from
    // here — one authority for identity, and it is the one with the human in
    // it. The relay's own uuid minting was a stopgap for a fixture with no
    // devices in it.
    const runnerId = approved.runnerId;

    // No timestamp: the store stamps `lastSeenAt` from its own clock, so
    // presence and the deadlines that reason about it agree (cloud_006 §3.4).
    await this.#deps.state.seen({
      runnerId,
      owner: parsed.data.owner,
      device: parsed.data.device,
    });

    return ok({
      protocolVersion: PROTOCOL_VERSION,
      runnerId,
      /** The *site's* key. See the note above — this is load-bearing. */
      site: site.site,
    });
  }

  /** Every authenticated call: signature first, then consent, then work. */
  async #authed<T>(
    input: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    run: (
      request: T,
      device: { runnerId: string; owner: string; device: PublicIdentity },
    ) => Promise<PlaneResult>,
    options: { allowRevoked?: boolean } = {},
  ): Promise<PlaneResult> {
    const signature = RequestSignature.safeParse(input.signature);
    if (!signature.success) {
      return fail(401, "unauthorized", "this request is not signed");
    }
    const known = await this.#deps.state.presence(signature.data.runnerId);
    if (!known) {
      return fail(401, "unauthorized", "this runner is not recognised");
    }

    const failure = verifyRequest({
      identityPublic: known.device.identity,
      endpoint: input.endpoint,
      body: input.rawBody,
      signature: signature.data,
      now: this.#deps.now(),
    });
    if (failure === "stale") return this.#clockSkew();
    if (failure) return fail(401, "unauthorized", "signature check failed");

    // Asked of the projection, not of the cached flag.
    //
    // `known.revoked` is set by `heartbeat`, and enforcing on it made
    // revocation depend on the client calling an endpoint: a daemon that
    // simply never heartbeats would go on claiming after its consent was
    // withdrawn, forever. A well-behaved daemon beats every few seconds, which
    // is why the freeze gate's "within one heartbeat" demo passed and why this
    // was invisible — the guarantee held for every client that wanted it to.
    //
    // The cached flag survives as what heartbeat *reports* to the daemon. It
    // is a message, not an authority, and the authority is the projection.
    // Two copies of one value where one is a stale mirror of the other is this
    // project's most-repeated bug; here it was also an enforcement hole.
    const revoked =
      this.#deps.projection.consentFor(known.owner, this.#deps.siteId) === null;
    if (revoked && options.allowRevoked !== true) {
      // Revocation reaches the daemon through heartbeat too, so heartbeat
      // itself must be answerable by a revoked runner — bouncing it with a 403
      // would read as a transport problem and it would keep trying.
      return fail(403, "revoked", "routing for this runner has been revoked");
    }

    known.lastSeenAt = this.#deps.now();

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      return fail(400, "bad-request", "request failed schema validation");
    }
    return run(parsed.data, known);
  }

  /**
   * A clock too far from ours, said plainly and with the number to fix it by.
   *
   * Its own error code rather than a generic `unauthorized`, because it is the
   * one refusal a retry can never fix and an `ntpdate` always can — the same
   * reasoning `version-unsupported` already carries on the daemon side. A
   * daemon that reports this as a generic rejection sends its owner looking at
   * their network.
   *
   * `serverTime` is included so the far side can say *how far off* rather than
   * *that something is wrong*. It is not a disclosure: the heartbeat response
   * returns the same value, and so does every `Date` header.
   */
  #clockSkew(): PlaneResult {
    return clockSkewRefusal(this.#deps.now());
  }

  claim(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ClaimRequest, async (request, device) => {
      if (request.runnerId !== device.runnerId) {
        return fail(401, "unauthorized", "runner id does not match the key");
      }
      // One store call. The decision and its write are the store's, because a
      // caller that reads, filters and writes back cannot be made atomic once
      // the store is on a network (cloud_006 §3.2).
      const granted = await this.#deps.state.claim({
        runnerId: device.runnerId,
        owner: device.owner,
        device: device.device,
        siteId: this.#deps.siteId,
        kinds: new Set(request.capabilities.map((c) => c.kind)),
        // The projection, collapsed to data the store can match on — a
        // predicate does not travel.
        owners: new Set(this.#deps.projection.ownersRunnableBy(device.owner)),
        max: request.max,
        leaseMs: this.#deps.leaseMs,
      });

      return ok({ jobs: granted, leaseMs: this.#deps.leaseMs });
    });
  }

  /**
   * Hand over the sealed payload, if the site has left one.
   *
   * The one endpoint whose behaviour differs from a direct site's, and the
   * difference is the whole design: a direct site seals here, on demand,
   * because it holds the keys. The relay waits. A `409` means "claimed, not
   * yet sealed" — a daemon should retry, not treat it as a refusal, because
   * the job is still legitimately theirs until the lease or the
   * awaiting-payload clock says otherwise.
   */
  fetch(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, FetchRequest, async (request, device) => {
      const taken = await this.#deps.state.takePayload({
        jobId: request.jobId,
        runnerId: device.runnerId,
        leaseId: request.leaseId,
      });
      if ("refused" in taken) return REFUSALS[taken.refused];
      return ok({ envelope: taken.envelope });
    });
  }

  /**
   * Take a sealed result.
   *
   * The relay stores ciphertext and records the disposition so it can stop
   * dispatching. It cannot check the two against each other — that requires
   * opening the envelope, which is the site's job and the site's key. This is
   * the asymmetry byollm_009 §6.1 describes: the hint is actionable here and
   * only verifiable there.
   */
  result(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ResultRequest, async (request, device) => {
      const recorded = await this.#deps.state.complete({
        jobId: request.jobId,
        runnerId: device.runnerId,
        leaseId: request.leaseId,
        envelope: request.envelope,
        disposition: request.disposition,
      });
      if ("refused" in recorded) return REFUSALS[recorded.refused];
      return ok(recorded);
    });
  }

  heartbeat(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      HeartbeatRequest,
      async (request, device) => {
        const now = this.#deps.now();
        await this.#deps.state.sweep();

        // Revocation is a fixture edit, and this is where the daemon learns
        // of it — within one heartbeat, which is what the freeze gate times.
        const consent = this.#deps.projection.consentFor(
          device.owner,
          this.#deps.siteId,
        );
        const revoked = consent === null;

        // A revoked runner renews nothing and is told it holds nothing, so it
        // abandons the queue rather than finishing it. Identical to the direct
        // plane's revoked branch, deliberately: the daemon cannot see which
        // upstream it is talking to and the rule must not depend on that.
        if (revoked) {
          return ok({
            revoked,
            cancel: [],
            lost: request.activeLeases.map((lease) => lease.jobId),
            serverTime: now,
          });
        }

        // Renewal and loss, from one read — cloud_008 §0.6. This used to
        // return `leases: []` unconditionally, which told a working daemon
        // every few seconds that nothing it held had been renewed while the
        // sweep requeued its work at `leaseMs`. Any job slower than a lease
        // was handed to a second device mid-flight.
        //
        // The renewal is the fix; reporting it back was not. §1.4b took that
        // field off the wire — no daemon ever read it, and `lost` answers the
        // same question in the direction a daemon can act on.
        // What the site withdrew — cloud_008 §2.2. This was the literal
        // `cancel: []`, so a site could not stop a job it had already
        // cancelled: the device went on running work whose result nobody
        // would accept, on somebody's own machine and at their expense.
        const cancel = await this.#deps.state.cancelRequests(device.runnerId);

        const { lost } = await this.#deps.state.renewLeases({
          runnerId: device.runnerId,
          leases: request.activeLeases,
          leaseMs: this.#deps.leaseMs,
        });

        return ok({
          revoked,
          cancel,
          lost,
          serverTime: now,
        });
      },
      { allowRevoked: true },
    );
  }

  release(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): Promise<PlaneResult> {
    return this.#authed(auth, body, ReleaseRequest, async (request, device) => {
      const released = await this.#deps.state.releaseLeases({
        runnerId: device.runnerId,
        leases: request.leases,
        // Was dropped here — cloud_008 §2.1. `reason` is on the wire, the
        // schema's own docstring says an upstream MUST record `refused`, and
        // this handler read every other field.
        reason: request.reason,
      });
      return ok({ released });
    });
  }
}

/**
 * Pairing, as the skeleton does it.
 *
 * Not the public `PairRequest`: that models a device-code exchange with a
 * human at a browser, and the skeleton's consent arrives from a fixture
 * instead (cloud_004 §14). The daemon-visible *outcome* is identical — a
 * runner id and the site's pinned public identity — so nothing downstream can
 * tell the difference, which is what makes this substitution honest rather
 * than a shortcut around the consent MUST.
 */
const PairFixtureRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    owner: z.string().min(1),
    device: PublicIdentity,
  })
  .strict();

/** Exported so the debug page can name a device the way a human would. */
export const fingerprintOf = (identity: PublicIdentity): string =>
  keyId(identity.identity);
