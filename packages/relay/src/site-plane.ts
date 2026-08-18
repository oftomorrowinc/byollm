import {
  keyId,
  JobStub,
  RequestSignature,
  SealedEnvelope,
  verifySiteRequest,
} from "@byollm/protocol";
import { z } from "zod";
import type { PlaneResult } from "./daemon-plane.js";
import type { Projection } from "./fixture.js";
import { clockSkewRefusal } from "./refusals.js";
import type { RoutingStore } from "./store.js";

/**
 * The plane a site talks to.
 *
 * **Outbound from the site, like everything else in this product.** A relay
 * that called site webhooks would need every site publicly reachable, which is
 * the connectivity problem the hub exists to delete — and it would put the
 * relay in the position of initiating contact, which is the posture the whole
 * design avoids. So a site polls, exactly as a daemon does, and the relay
 * never opens a connection to anyone.
 *
 * ## The three-beat exchange
 *
 * A site cannot seal at enqueue: a payload is encrypted to the device that
 * claims it, and at enqueue nobody has. So enqueue publishes a **stub**, and
 * sealing happens later, on demand:
 *
 * 1. `enqueue` — here is a stub; route it.
 * 2. `pending` — who claimed anything of mine, and what key do I seal to?
 * 3. `payload` — here is the ciphertext for that device.
 *
 * Then `results` collects what comes back. Four endpoints, all polled, none of
 * which ever carries a plaintext or a private key.
 *
 * The gap between beats 2 and 3 is the `awaiting-payload` state, and the
 * reason it needs its own timeout: a site that dies between them leaves a
 * device holding a job whose work will never arrive.
 *
 * ## Every call is signed, and this plane once was not
 *
 * A site authenticates exactly as a daemon does: it signs each request with
 * the identity key the control plane registered for it, and the relay checks
 * that signature against the projection. Nothing here trusts a `siteId` in a
 * body or a query string.
 *
 * This was the ninth finding, and it was found by reading the code in
 * preparation for the first public deploy rather than by any test — the whole
 * plane took the caller's word for who it was. What that bought an anonymous
 * caller, against a relay reachable on the internet:
 *
 * - **`enqueue` as anyone.** Publish stubs in a site's name and consenting
 *   users' machines claim them. The payload that follows is sealed by the real
 *   site or not at all, so no forged *work* runs — but unsolicited dispatch to
 *   private hardware is a product-level breach whatever the ciphertext does.
 * - **`payload` as anyone**, over a live claim: substitute an envelope the
 *   daemon will refuse to open, and the job is burned rather than run.
 * - **`pending` and `results` as anyone**: a metadata read of who is online
 *   for a site, which device claimed what, and every lease id in flight.
 *
 * `RELAY_BLIND` held throughout — none of it opens a payload, which is the
 * point of building it that way. But blind is not the same as safe, and the
 * distance between them is this file.
 */

const EnqueueRequest = z
  .object({
    siteId: z.string().min(1),
    /**
     * Everything the relay learns about the job.
     *
     * `JobStub` is exhaustive by construction and asserted so in the protocol
     * package — a site that tried to attach a prompt here would be refused by
     * the schema, not by a reviewer.
     */
    stub: JobStub,
  })
  .strict();

const PayloadRequest = z
  .object({
    siteId: z.string().min(1),
    jobId: z.string().min(1),
    /** Sealed to the claiming device. Opaque to us and to the schema. */
    envelope: SealedEnvelope,
  })
  .strict();

/** A read: the site id arrives in the query and is signed as an empty body. */
const QueryRequest = z.object({ siteId: z.string().min(1) }).strict();

const ok = (body: unknown): PlaneResult => ({ status: 200, body });
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

export interface SitePlaneDeps {
  readonly state: RoutingStore;
  readonly projection: Projection;
  readonly now: () => number;
  /**
   * The one site this relay routes for.
   *
   * The same value the daemon plane holds, from the same option, because it is
   * the same fact — a relay that accepted enqueues for sites its daemons never
   * paired with would route work nobody can open.
   */
  readonly routesFor: string;
}

/** What `Relay.handle` reconstructs from the request, for signature checking. */
export interface SiteAuth {
  /** The endpoint name alone — the domain separator is applied by protocol. */
  readonly endpoint: string;
  /** The exact bytes received, hashed into the signature. */
  readonly rawBody: string;
  /** From the headers, or undefined if any part was missing. */
  readonly signature: unknown;
}

export class SitePlane {
  readonly #deps: SitePlaneDeps;

  constructor(deps: SitePlaneDeps) {
    this.#deps = deps;
  }

  /**
   * Signature first, then the site id, then the work.
   *
   * The caller is whoever the signature says, verified against the key the
   * control plane registered — never whoever the request claims. The `siteId`
   * every request carries is then required to *match* that caller, so the two
   * can never name different sites; a request that says one thing in its
   * signed material and another in its body is refused rather than reconciled.
   *
   * Every endpoint goes through here, including the reads. That is deliberate:
   * an authenticated write plane beside an open read plane would still hand a
   * stranger presence, claims and lease ids, and "who is online right now" is
   * exactly the fact a blind relay is otherwise so careful not to reveal.
   */
  async #authed<T>(
    auth: SiteAuth,
    body: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
    siteIdOf: (request: T) => string,
    run: (request: T, siteId: string) => Promise<PlaneResult>,
  ): Promise<PlaneResult> {
    const signature = RequestSignature.safeParse(auth.signature);
    if (!signature.success) {
      return fail(401, "unauthorized", "this request is not signed");
    }
    // The signature's caller slot carries the site id (byollm_009 §4.2's
    // site-plane note). Resolving the key through the site registry rather
    // than the device registry is what keeps a device signature from ever
    // authenticating as a site.
    const siteId = signature.data.runnerId;
    const site = this.#deps.projection.siteFor(siteId);
    if (!site) {
      return fail(401, "unauthorized", "this site is not registered");
    }

    const failure = verifySiteRequest({
      identityPublic: site.site.identity,
      endpoint: auth.endpoint,
      body: auth.rawBody,
      signature: signature.data,
      now: this.#deps.now(),
    });
    // `stale` is not a bad signature — cloud_008 §1.4, finding 17.
    //
    // `verifySiteRequest` distinguishes the two and this used to throw the
    // distinction away, so a site whose clock had drifted was told its
    // signature was wrong. The daemon plane had said so correctly for weeks;
    // the site plane three files over had not, which is what two
    // implementations of one refusal looks like from the inside.
    // Ordered so a failure kind added later reports `unauthorized` rather
    // than claiming a clock problem nobody diagnosed.
    if (failure === "stale") return clockSkewRefusal(this.#deps.now());
    if (failure) return fail(401, "unauthorized", "signature check failed");

    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      return fail(400, "bad-request", "request failed schema validation");
    }
    if (siteIdOf(parsed.data) !== siteId) {
      return fail(403, "unauthorized", "that is not your site");
    }
    // This relay routes for exactly one site, and now says so.
    //
    // The daemon plane has always been single-tenant — `DaemonPlaneDeps.siteId`
    // is the field multi-tenancy replaces — but the site plane accepted any
    // registered site, and `claim` never looked at a job's `siteId` at all. A
    // second registered site's jobs would therefore be offered to a daemon
    // paired with the first, which pinned a different key and could only fail
    // to open the payload. Contained by the crypto, and still a job burned by
    // routing rather than by anything the device did.
    if (siteId !== this.#deps.routesFor) {
      return fail(403, "unauthorized", "this relay does not route for you");
    }
    return run(parsed.data, siteId);
  }

  enqueue(auth: SiteAuth, body: unknown): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      EnqueueRequest,
      (request) => request.siteId,
      async (request, siteId) => {
        // The stub names a site; the signature says who is asking. They have
        // to agree — Amendment A §A.3.
        //
        // Same rule the `siteId` in the body already follows, applied one
        // level in: a caller that could publish stubs naming *another* site
        // would be handing that site's daemons work sealed by the wrong key,
        // and every one of them would report a corrupt envelope rather than an
        // impersonation. `siteFor` is non-null here — `#authed` resolved the
        // caller through it — and the optional chain is what makes a later
        // edit to that invariant produce a refusal instead of a crash.
        const registered = this.#deps.projection.siteFor(siteId);
        if (
          !registered ||
          keyId(registered.site.identity) !== request.stub.site
        ) {
          return fail(
            403,
            "unauthorized",
            "that stub does not name the site that signed it",
          );
        }

        const job = await this.#deps.state.enqueue({
          id: request.stub.id,
          siteId,
          stub: request.stub,
        });
        // Idempotent by id: a known id returns what is already routing. Only
        // one site can reach this relay, so a known id is always this site's
        // republish. The multi-tenant router needs a collision check here, and
        // it gets one when it can be exercised — an unreachable guard is a
        // test that cannot fail, which this project has now written twice.
        return ok({ jobId: job.id, state: job.state });
      },
    );
  }

  /**
   * What needs sealing, and who to seal it to.
   *
   * The response carries the claiming device's **public** keys — which is the
   * entire reason a blind relay can exist. The relay is a directory here, not
   * a participant: it tells the site an address, and what the site sends to
   * that address is unreadable on the way through.
   */
  pending(auth: SiteAuth, siteId: string): Promise<PlaneResult> {
    return this.#authed(
      auth,
      { siteId },
      QueryRequest,
      (request) => request.siteId,
      async (_request, site) => {
        await this.#deps.state.sweep();
        const jobs = (await this.#deps.state.awaiting(site)).map((job) => ({
          jobId: job.id,
          // Non-null by construction: `awaiting` only returns claimed jobs.
          // The optional chain is here so a future state-machine edit that
          // broke that invariant would produce a missing field rather than a
          // crash on the routing path.
          device: job.claimedBy?.device,
          runnerId: job.claimedBy?.runnerId,
          leaseId: job.claimedBy?.leaseId,
          /** So a site can decline to seal for a claim about to expire. */
          awaitingUntil: job.awaitingUntil,
          /**
           * When the *grant* ends — cloud_008 §0.6.
           *
           * Distinct from `awaitingUntil`, which bounds how long this relay
           * waits for the site to seal. A site adopting the lease into its own
           * records needs the lease's clock; given the other one it recorded a
           * grant that expired in seconds, then refused the device's own
           * result for want of a matching lease.
           */
          leaseExpiresAt: job.claimedBy?.leaseExpiresAt,
        }));
        return ok({ jobs });
      },
    );
  }

  payload(auth: SiteAuth, body: unknown): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      PayloadRequest,
      (request) => request.siteId,
      async (request, siteId) => {
        // One store call: the check and the write together. A site that read
        // "awaiting-payload" and then wrote would be racing the timeout that
        // makes the state mean anything.
        const sealed = await this.#deps.state.seal({
          jobId: request.jobId,
          siteId,
          envelope: request.envelope,
        });
        if ("refused" in sealed) {
          return sealed.refused === "not-found"
            ? fail(404, "not-found", "unknown job")
            : fail(
                409,
                "too-late",
                `job is ${sealed.was ?? "gone"}, not awaiting payload`,
              );
        }
        return ok({ jobId: request.jobId, state: sealed.state });
      },
    );
  }

  /** Sealed results, for the site to open and verify. */
  results(auth: SiteAuth, siteId: string): Promise<PlaneResult> {
    return this.#authed(
      auth,
      { siteId },
      QueryRequest,
      (request) => request.siteId,
      async (_request, site) => {
        const jobs = (await this.#deps.state.finished(site)).map((job) => ({
          jobId: job.id,
          envelope: job.result,
          disposition: job.disposition,
          runnerId: job.claimedBy?.runnerId,
          /** The grant the site adopted, so it can complete against it. */
          leaseId: job.claimedBy?.leaseId,
          /**
           * Which device ran it, so the site can verify the signature against
           * the key it was told to seal to — and so `PROVENANCE_NAMES_DEVICE` can
           * name a foreign device rather than guessing (cloud_004 §11.2).
           */
          device: job.claimedBy?.device,
        }));
        return ok({ jobs });
      },
    );
  }
}
