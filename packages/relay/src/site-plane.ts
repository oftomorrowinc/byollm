import {
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  envelopeBytes,
  keyId,
  JobStub,
  RequestSignature,
  SealedEnvelope,
  verifySiteRequest,
} from "@byollm/protocol";
import { z } from "zod";
import type { PlaneResult } from "./daemon-plane.js";
import type { Projection } from "./fixture.js";
import { clockSkewRefusal, tooLargeRefusal } from "./refusals.js";
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
    protocolVersion: z.literal(PROTOCOL_VERSION),
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
    protocolVersion: z.literal(PROTOCOL_VERSION),
    siteId: z.string().min(1),
    jobId: z.string().min(1),
    /** Sealed to the claiming device. Opaque to us and to the schema. */
    envelope: SealedEnvelope,
  })
  .strict();

/** A read: the site id arrives in the query and is signed as an empty body. */
/** What a site sends to withdraw a job. */
const CancelRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    siteId: z.string().min(1),
    jobId: z.string().min(1),
  })
  .strict();

// No version here: a read declares it in the query string, which is where
// `declaredVersion` looks for a GET, and this object is built from that same
// query rather than parsed from a body.
const QueryRequest = z.object({ siteId: z.string().min(1) }).strict();

const ok = (body: unknown): PlaneResult => ({ status: 200, body });
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

/**
 * Whether a purpose can be satisfied for this person, asked at enqueue.
 *
 * The relay does not hold the answer and must not: a relay that filtered on
 * mappings would hold the mapping, which is the one thing it cannot have. So
 * it asks — of the control plane, which already answers the same question at
 * claim, from the same authority, a moment later.
 *
 * Three replies, because three things are true at three different times.
 * `not-declared` is the site's own manifest and is fixed by the developer.
 * `unmapped` is the person's own dashboard and is fixed by them. `ok` covers
 * everything the transient path was always for: declared, mapped, and no
 * device able to claim right now.
 *
 * Optional, because a self-hosted relay may have no control plane. When it is
 * absent nothing is refused — and the relay says so at boot and on its health
 * surface, because a check that quietly is not there is the skipping-check law
 * wearing deployment.
 */
export interface SitePlaneDeps {
  readonly state: RoutingStore;
  readonly projection: Projection;
  readonly now: () => number;
  /**
   * Asked once per enqueue, when a control plane is present.
   *
   * What this teaches the relay is one bit it did not previously hold:
   * whether this owner has *a* mapping for this purpose. Existence, never
   * which service — that stays in the control plane, and this is recorded in
   * the enumerated-metadata commitment so the list stays exhaustive.
   */
  readonly satisfiable?: (query: {
    readonly siteId: string;
    readonly owner: string;
    readonly purpose: string | undefined;
    readonly kind: string;
  }) => Promise<{
    readonly verdict: "ok" | "not-declared" | "unmapped";
  }>;
  /**
   * The one site this relay routes for.
   *
   * The same value the daemon plane holds, from the same option, because it is
   * the same fact — a relay that accepted enqueues for sites its daemons never
   * paired with would route work nobody can open.
   */
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

    /**
     * Which keys may sign for this site right now — byollm_009 Amendment C.
     *
     * The current one, and — while a retirement window is open — the key it
     * just superseded. **Both keys route while the window is open** (C.2): a
     * site that rotated is a site with two processes mid-deploy and a queue of
     * work signed a minute ago, and refusing the old key the instant the
     * record moves makes rotation a flag day.
     *
     * The site id in the caller slot does not change across a rotation — it is
     * the control plane's name for the site, not a key id — so this cannot be
     * decided by looking at who is calling. It is decided by which key
     * verifies, which is the honest question.
     *
     * The predecessors come from the chain the site itself signed, so this
     * widens nothing: a key that can authenticate here is one the current key
     * has vouched for in a statement naming both. And the window is measured
     * against the relay's clock, because a window a caller could assert would
     * not be a window.
     */
    const acceptable = [
      site.site.identity,
      ...(site.retiringUntil !== undefined &&
      this.#deps.now() < site.retiringUntil
        ? (site.succeeds ?? []).map((link) => link.identity.identity)
        : []),
    ];

    // Tried in order, current key first, and the *last* failure is the one
    // reported: a site whose clock has drifted fails every key with `stale`,
    // and telling it its signature was wrong would send it looking in the one
    // place the problem is not — finding 17, which this loop could quietly
    // undo.
    // Seeded with a refusal rather than left unassigned: `acceptable` always
    // has at least the current key, but a loop that can be entered zero times
    // must not be able to fall through into an authenticated request.
    let failure: ReturnType<typeof verifySiteRequest> = "bad-signature";
    for (const identityPublic of acceptable) {
      failure = verifySiteRequest({
        identityPublic,
        endpoint: auth.endpoint,
        body: auth.rawBody,
        signature: signature.data,
        now: this.#deps.now(),
      });
      if (!failure) break;
      // A stale signature is stale against every key; no point asking again.
      if (failure === "stale") break;
    }
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
      return fail(403, "forbidden", "that is not your site");
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
    // Registered, rather than "the one site this relay was configured with"
    // — cloud_009 §3. Every registered site is routable now; what a relay
    // refuses is a caller naming a site its projection does not hold.
    //
    // Which is checked **above**, where the signature is resolved: a site the
    // projection does not hold has no key to verify against and is refused
    // 401 before reaching here. The second check that used to stand at this
    // line was dead — V1-17 — and dead guards are worse than absent ones:
    // they read as the enforcement, so the day somebody moves the real check
    // they leave this one behind and nothing looks different.
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
            // V1-13, and one of the five the ruling itself named: an
            // identified site claiming another site's stub is `forbidden`.
            "forbidden",
            "that stub does not name the site that signed it",
          );
        }

        /**
         * Refused here, or never — the two answers a site can act on.
         *
         * Both are knowable now and neither becomes knowable later. A purpose
         * the manifest does not declare will not appear in it by waiting, and
         * a person who maps a slot thirty seconds from now is served by the
         * next job, which is the same thirty seconds. Queuing either would be
         * a poll wearing a promise — and worse, a job the site has already
         * fallen back on must never be served afterwards.
         *
         * The third case is the one the transient path was always for:
         * declared, mapped, and nothing able to claim it right now.
         */
        /**
         * A read that failed is not a negative answer — and not a 500 either.
         *
         * This call reaches the control plane's policy store. A blip there —
         * a connection reset, a failover, a pool exhausted — threw straight
         * out of `handle`, so every cloud-lane enqueue became `internal`
         * while the database caught its breath.
         *
         * The property that matters already held: nothing turns a failed read
         * into `not-declared` or `unmapped`, so no job was ever refused for a
         * reason nobody could check. What was wrong is what the site was
         * told. `internal` says "we are broken and you should stop"; this is
         * a transient condition, and the honest answer is ask again.
         *
         * 503 rather than a 409, deliberately. The enqueue endpoint's 409
         * class *is* the refusal class — an unknown code there is read as
         * `EnqueueRefused` and the job is abandoned. A transient failure
         * arriving in that class would tell a site to give up on a job the
         * relay never even evaluated.
         *
         * Not swallowed into "satisfiable" either, which would be the other
         * tempting shape: accepting the job and letting it expire is the
         * pre-alpha.65 behaviour, and the whole point of that release was
         * that a slot nobody can answer should not cost the site a TTL.
         */
        let answer;
        try {
          answer = await this.#deps.satisfiable?.({
            siteId,
            owner: request.stub.owner,
            purpose: request.stub.purpose,
            kind: request.stub.kind,
          });
        } catch {
          // The reason stays here. A site learns that we could not answer,
          // never that a database was the thing that could not.
          return fail(
            503,
            "server-error",
            "we could not check this just now — try again shortly",
          );
        }
        if (answer?.verdict === "not-declared") {
          return fail(
            409,
            "purpose-not-declared",
            `this site does not declare ${request.stub.purpose ?? "that purpose"} — ` +
              "declare it on Developer Sites, and the people who have already " +
              "connected will each map the new slot before it routes",
          );
        }
        if (answer?.verdict === "unmapped") {
          // One sentence, never why. Which service, whose device and whether
          // one exists are all the person's, and a site learns only that the
          // slot is unsatisfiable — the opacity is the promise, not a
          // side-effect of it.
          return fail(
            409,
            "slot-unsatisfiable",
            "nobody has chosen what answers this yet",
          );
        }

        const job = await this.#deps.state.enqueue({
          id: request.stub.id,
          siteId,
          stub: request.stub,
        });
        // Idempotent by id **within a site** — cloud_008 finding 58. A known
        // id from the same site is that site's republish and returns what is
        // already routing; a known id from another site is refused rather
        // than answered with the other site's job.
        //
        // The comment here used to say the multi-tenant router would need a
        // collision check "when it can be exercised", on the argument that an
        // unreachable guard is a test that cannot fail. That was right about
        // the test and wrong about where the guard belongs: the store owns
        // idempotency, so the store owns the exception to it, and the check
        // is exercised there against both implementations. This is the wire's
        // half of it.
        if ("refused" in job) {
          // **Says nothing about why** — cloud_008 finding 58, second pass.
          //
          // "that job id belongs to another site" is a cross-tenant existence
          // oracle: a site that guessed or was leaked an id could confirm
          // another tenant holds it. Ids are random, so enumeration is not
          // practical, and a confirmation should still not be available for
          // the asking.
          //
          // This reduces the leak and does not remove it, which is worth
          // saying rather than claiming a fix: a site knows its own stub is
          // well-formed, so *any* refusal it can tell apart from success is
          // the confirmation, whatever the message says. The only real fix is
          // a collision that cannot happen — per-site keys, cloud_009 §3's
          // first store decision — and this refusal disappears with it.
          return fail(400, "bad-request", "that stub was not accepted");
        }
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

  /**
   * The site withdraws a job — cloud_008 §2.2.
   *
   * Signed and site-scoped like every other site-plane call. A cancellation
   * is not a delete: a device already running the job has to be told, and it
   * hears at its next heartbeat.
   */
  cancel(auth: SiteAuth, body: unknown): Promise<PlaneResult> {
    return this.#authed(
      auth,
      body,
      CancelRequest,
      (request) => request.siteId,
      async (request, siteId) => {
        const cancelled = await this.#deps.state.cancel({
          jobId: request.jobId,
          siteId,
        });
        // Idempotent, and quiet about what it did not find: a site asking
        // twice is ordinary, and answering differently for "already
        // cancelled" and "never existed" would tell an unrelated caller
        // whether an id is real.
        return ok({ cancelled });
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
        // The ceiling, before acceptance — ratified 2026-08-28. Refused here
        // rather than after the store call, because the point of a
        // relay-memory rail is that the oversized thing is never held.
        const bytes = envelopeBytes(request.envelope);
        if (bytes > MAX_ENVELOPE_BYTES) return tooLargeRefusal(bytes);

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
          /**
           * Whose machine ran it — cloud_008 §2.5, finding 41.
           *
           * The relay has held this since the claim: `claimedBy.owner` is the
           * owner id the *projection* supplied, in the same namespace the
           * direct plane's `runnerOwner` uses. The cloud lane was filling that
           * field with `keyId(device.identity)` instead — a key id where every
           * other plane puts a user id, so an app comparing provenance across
           * lanes compared two namespaces for equality and got `false` for
           * the same person.
           */
          runnerOwner: job.claimedBy?.owner,
        }));
        return ok({ jobs });
      },
    );
  }
}
