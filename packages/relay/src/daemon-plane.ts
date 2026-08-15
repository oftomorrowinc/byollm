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
  type ClaimedStub,
} from "@byollm/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Projection } from "./fixture.js";
import { AWAITING_PAYLOAD_MS, type RelayState } from "./state.js";

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
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

export interface DaemonPlaneDeps {
  readonly state: RelayState;
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
  pair(body: unknown): PlaneResult {
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
      return fail(403, "unauthorized", "no consent record for this user");
    }

    // Minted here, not accepted from the device. The direct plane's server
    // mints a runner id at approval and a device has never named itself; a
    // relay that let one would take an identifier from the least trusted
    // party in the exchange. A uuid because the stores that eventually
    // record leases against it type their id columns that way.
    const runnerId = randomUUID();

    this.#deps.state.seen({
      runnerId,
      owner: parsed.data.owner,
      device: parsed.data.device,
      lastSeenAt: this.#deps.now(),
    });

    return ok({
      protocolVersion: PROTOCOL_VERSION,
      runnerId,
      /** The *site's* key. See the note above — this is load-bearing. */
      site: consent.site,
    });
  }

  /** Every authenticated call: signature first, then consent, then work. */
  #authed<T>(
    input: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    run: (
      request: T,
      device: { runnerId: string; owner: string; device: PublicIdentity },
    ) => PlaneResult,
    options: { allowRevoked?: boolean } = {},
  ): PlaneResult {
    const signature = RequestSignature.safeParse(input.signature);
    if (!signature.success) {
      return fail(401, "unauthorized", "this request is not signed");
    }
    const known = this.#deps.state.presence(signature.data.runnerId);
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
    if (failure) return fail(401, "unauthorized", "signature check failed");

    // Revocation reaches the daemon through heartbeat, so heartbeat itself
    // must be answerable by a revoked runner — bouncing it with a 403 would
    // read to the daemon as a transport problem and it would keep trying.
    if (known.revoked && options.allowRevoked !== true) {
      return fail(403, "revoked", "routing for this runner has been revoked");
    }

    known.lastSeenAt = this.#deps.now();

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      return fail(400, "bad-request", "request failed schema validation");
    }
    return run(parsed.data, known);
  }

  claim(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): PlaneResult {
    return this.#authed(auth, body, ClaimRequest, (request, device) => {
      if (request.runnerId !== device.runnerId) {
        return fail(401, "unauthorized", "runner id does not match the key");
      }
      const now = this.#deps.now();
      this.#deps.state.sweep(now);

      const kinds = new Set(request.capabilities.map((c) => c.kind));
      const granted: ClaimedStub[] = [];

      for (const job of this.#deps.state.jobs()) {
        if (granted.length >= request.max) break;
        if (job.state !== "queued") continue;
        if (!kinds.has(job.stub.kind)) continue;
        // The relay's half of AUDIENCE_BOTH_SIDES. The daemon re-checks its
        // own allowlist and may still refuse — this only narrows.
        if (!this.#deps.projection.mayRunFor(device.owner, job.stub.owner)) {
          continue;
        }

        // A UUID, not a readable composite. The direct plane's lease ids are
        // UUIDs and the Supabase adapter's `lease_id` column is typed `uuid`
        // — so a relay minting `lease_<job>_<time>` would route perfectly
        // against a memory store and fail the moment a real site adopted the
        // lease into Postgres. Same shape as the `job_<uuid>` bug: an id that
        // is only a string until something declares what kind of string.
        const leaseId = randomUUID();
        job.state = "awaiting-payload";
        job.claimedBy = {
          runnerId: device.runnerId,
          owner: device.owner,
          device: device.device,
          leaseId,
          leaseExpiresAt: now + this.#deps.leaseMs,
        };
        // The clock §7 requires and the direct plane never needed. It is not
        // the lease: it bounds how long we wait for a site, not how long the
        // device may work.
        job.awaitingUntil = now + AWAITING_PAYLOAD_MS;

        granted.push({
          ...job.stub,
          lease: {
            id: leaseId,
            runnerId: device.runnerId,
            expiresAt: job.claimedBy.leaseExpiresAt,
          },
        });
      }

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
  ): PlaneResult {
    return this.#authed(auth, body, FetchRequest, (request, device) => {
      const job = this.#deps.state.job(request.jobId);
      if (!job) return fail(404, "not-found", "unknown job");
      if (job.claimedBy?.runnerId !== device.runnerId) {
        return fail(403, "unauthorized", "this runner does not hold the job");
      }
      if (job.claimedBy.leaseId !== request.leaseId) {
        // LEASE_HONORED per *instance*: a stale lease id names a grant that
        // is over, and answering it would hand work to a previous holder.
        return fail(403, "unauthorized", "that lease is no longer current");
      }
      if (!job.payload) {
        return fail(409, "not-ready", "the site has not sealed this job yet");
      }
      job.state = "running";
      return ok({ envelope: job.payload });
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
  ): PlaneResult {
    return this.#authed(auth, body, ResultRequest, (request, device) => {
      const job = this.#deps.state.job(request.jobId);
      if (!job) return fail(404, "not-found", "unknown job");
      if (job.claimedBy?.runnerId !== device.runnerId) {
        return fail(403, "unauthorized", "this runner does not hold the job");
      }
      if (job.state === "done") {
        return ok({ accepted: false, state: job.state });
      }
      job.result = request.envelope;
      job.disposition = request.disposition;
      job.state = "done";
      return ok({ accepted: true, state: job.state });
    });
  }

  heartbeat(
    auth: { endpoint: string; rawBody: string; signature: unknown },
    body: unknown,
  ): PlaneResult {
    return this.#authed(
      auth,
      body,
      HeartbeatRequest,
      (request, device) => {
        const now = this.#deps.now();
        this.#deps.state.sweep(now);

        const known = this.#deps.state.presence(device.runnerId);
        // Revocation is a fixture edit, and this is where the daemon learns
        // of it — within one heartbeat, which is what the freeze gate times.
        const consent = this.#deps.projection.consentFor(
          device.owner,
          this.#deps.siteId,
        );
        const revoked = consent === null;
        if (known) known.revoked = revoked;

        // Anything this runner thinks it holds that we no longer agree it
        // holds. A daemon must stop work on these rather than finish and
        // report into a lease that is gone.
        const lost = request.activeLeases
          .filter(({ jobId, leaseId }) => {
            const job = this.#deps.state.job(jobId);
            return job?.claimedBy?.leaseId !== leaseId;
          })
          .map(({ jobId }) => jobId);

        return ok({
          revoked,
          cancel: [],
          leases: [],
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
  ): PlaneResult {
    return this.#authed(auth, body, ReleaseRequest, (request, device) => {
      const released: string[] = [];
      for (const { jobId, leaseId } of request.leases) {
        const job = this.#deps.state.job(jobId);
        if (!job || job.claimedBy?.runnerId !== device.runnerId) continue;
        if (job.claimedBy.leaseId !== leaseId) continue;
        this.#deps.state.requeue(job);
        released.push(jobId);
      }
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
