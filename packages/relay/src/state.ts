import type {
  CapabilityMatrix,
  ClaimedStub,
  JobStub,
  PublicIdentity,
  SealedEnvelope,
  WithheldKind,
} from "@byollm/protocol";
import { randomUUID } from "node:crypto";
import type { Grant, RoutingStore } from "./store.js";

/**
 * The relay's routing state — byollm_009 §7, reachable at last.
 *
 * §7 described a state machine the direct plane could not produce. There, the
 * site and the upstream are the same party: it seals when it likes, and a job
 * is never claimed-but-unsealed. Here they are different parties, and the gap
 * between them is a state:
 *
 * ```
 * queued ──claim──▶ awaiting-payload ──sealed──▶ ready ──fetch──▶ running
 *    ▲                    │                                          │
 *    └────────────────────┘                                          ▼
 *      site never seals, or seals too late              ok | error | canceled
 * ```
 *
 * The relay cannot seal, so it cannot shortcut this. A payload is encrypted
 * to *the device that claimed it*, and nobody knows which device that is until
 * the claim happens — which is precisely why claim-then-fetch makes a blind
 * relay possible at all. The window is the price.
 *
 * ## What the relay holds, and what it cannot
 *
 * Stubs (metadata the site chose to publish), sealed envelopes it cannot open,
 * and public keys. There is no field on any type in this file that could hold
 * a private key or a plaintext, which is `RELAY_BLIND` expressed as a data
 * model rather than as a policy.
 */

/** Where a routed job is. */
export type RoutedState =
  "queued" | "awaiting-payload" | "ready" | "running" | "done";

/**
 * How long a site has to seal after one of its jobs is claimed.
 *
 * **Distinct from the lease, and distinct from the job's TTL** — byollm_009
 * §7.1. Three clocks, three different questions:
 *
 * - the **TTL** asks how long the work is worth doing at all;
 * - the **lease** asks how long this device gets to run it;
 * - this asks how long we wait for a site that has gone away.
 *
 * Collapsing any pair of them looks harmless until a site restarts during a
 * deploy: with only a lease, the device sits politely holding a job whose
 * payload will never arrive, and the lease's whole minute is spent waiting on
 * a party that is not coming back. Short, because a site that is up answers in
 * milliseconds and a site that is down will not answer sooner for waiting.
 */
export const AWAITING_PAYLOAD_MS = 10_000;

/** A job the relay is routing. Metadata and ciphertext, nothing else. */
/** Why a daemon gave a job back. Only `refused` means "not me, ever". */
export type ReleaseReason =
  "shutdown" | "pause" | "revoked" | "backend-down" | "refused";

export interface RoutedJob {
  readonly id: string;
  /** Which site enqueued it — the party that will be asked to seal. */
  readonly siteId: string;
  /**
   * Everything the relay knows about the work, which is everything the site
   * chose to publish and not one field more (byollm_009 §6).
   */
  readonly stub: JobStub;
  state: RoutedState;
  /** Set from the claim; the site seals to these keys. */
  claimedBy?: {
    readonly runnerId: string;
    readonly owner: string;
    readonly device: PublicIdentity;
    readonly leaseId: string;
    readonly leaseExpiresAt: number;
  };
  /** When {@link AWAITING_PAYLOAD_MS} runs out for this claim. */
  awaitingUntil?: number;
  /**
   * Runners that released this job with reason `refused` — cloud_008 §2.1.
   *
   * `REFUSAL_NOT_REOFFERED`, which the relay did not implement: it dropped
   * `ReleaseRequest.reason` on the floor. The field's own docstring says why
   * that is not cosmetic — an upstream cannot evaluate a daemon's *local*
   * `named` allowlist, so it may legitimately offer work the daemon then
   * declines, and without a record the two spin between claim and release
   * forever. The direct plane has always kept this list.
   */
  refusedBy: string[];
  /**
   * The site withdrew this job — cloud_008 §2.2.
   *
   * A flag rather than a state, because a cancelled job that a device is
   * *running* is not finished: the daemon has to be told, abort its backend
   * call and report `canceled`, and the ordinary `complete` path then closes
   * it. Making it a state would strand the in-flight case between two
   * machines' ideas of what happened.
   */
  cancelled?: boolean;
  /** Sealed to the claiming device by the site. Opaque here. */
  payload?: SealedEnvelope;
  /** Sealed to the site by the device. Opaque here. */
  result?: SealedEnvelope;
  /**
   * The result's clear-text discriminator — byollm_009 §6.1.
   *
   * The one outcome fact the relay is given, and the reason it is given:
   * without it the relay cannot stop dispatching a finished job. A routing
   * hint and never a fact — the *site* verifies it against the sealed
   * outcome, because only the site can open the envelope. The relay acts on
   * it and is entitled to be wrong; a lying daemon costs it a dispatch
   * decision, not a security property.
   */
  disposition?: "ok" | "error" | "canceled";
}

/** A device the relay has seen recently. */
export interface Presence {
  readonly runnerId: string;
  readonly owner: string;
  readonly device: PublicIdentity;
  lastSeenAt: number;
  /**
   * What this machine last said it can run — cloud_009, 2026-08-24.
   *
   * **Capabilities are presence data.** They arrive on the same heartbeat as
   * everything else here, they go stale at the same moment and for the same
   * reason, and a machine that stops heartbeating has not stopped being able
   * to run Llama — it has stopped being somewhere we can ask. Keeping them
   * anywhere else would put capability truth outside the interface that owns
   * presence, and every next consumer (a member's usable set, a dashboard's
   * pulse, a degraded-state banner) would re-derive it from a different
   * place. That is the two-owners shape this codebase keeps paying for.
   *
   * Empty is a real answer, not a missing one: it is a paired machine with no
   * healthy backend, which is a legal state the whole connect-first ruling
   * exists to make visible rather than refuse.
   */
  capabilities: CapabilityMatrix;
  /**
   * Kinds this machine is deliberately *not* advertising — byollm_016.
   *
   * Presence data for the same reason capabilities are, and stored beside
   * them rather than derived: two services answering one kind with no
   * `defaults` entry is a state only the daemon can see, and the hub cannot
   * reconstruct it from the matrix — an absent kind and a withheld kind look
   * identical there. Without this field the owner's page can say "nothing
   * serves llm.generate", which is true and useless, instead of "two services
   * answer it and you have not chosen", which is the sentence that ends with
   * the owner doing something.
   *
   * Empty is the normal answer, and means every kind resolved.
   */
  withheld: readonly WithheldKind[];
  // `revoked` is deliberately absent — cloud_008 §2.3.
  //
  // It was a boolean on the *runner*, written at heartbeat and read by
  // nothing but the debug page. Enforcement had already moved to the
  // projection, because enforcing on this flag made revocation depend on the
  // client calling an endpoint: a daemon that simply never heartbeat went on
  // claiming forever. What survived was the cache, which is a stored copy of
  // a derived fact — this project's most-repeated bug, kept alive here as a
  // display value.
  //
  // It is also a concept multi-tenancy cannot express. Revocation is a fact
  // about an (owner, site) pair; a daemon serving two sites and revoked at
  // one is not "a revoked runner", and a boolean on the device has nowhere to
  // put the difference. Deleting it now is what stops cloud_009 inheriting a
  // field it would have to contradict.
}

/**
 * What a routing store must do, expressed as operations — cloud_006 §3.2.
 *
 * Every method below is a **decision plus its write**, never a read the caller
 * follows with a mutation. That is the whole point, and it is the difference
 * between an interface a shared store can implement and one it cannot.
 *
 * `claim` is the specimen. It used to live in `DaemonPlane` as
 * `jobs()` → filter → mutate, which is atomic for exactly one reason: Node is
 * single-threaded and these Maps are local, so nothing runs between the read
 * and the write. Neither survives a store on a network, and
 * `packages/relay/test/two-replicas.test.ts` holds the resulting race as a
 * failing assertion.
 *
 * So the rule for anything added here: **if a caller has to read, decide, and
 * write back, the operation is in the wrong place.** Move the decision in.
 *
 * ## Why the projection does not come with it
 *
 * `claim` takes `owners: string[]` rather than a projection or a predicate.
 * A closure cannot travel to Valkey, and the projection replicates for free
 * from the control plane — so the caller collapses it with
 * `Projection.ownersRunnableBy` and hands over data the store can match on.
 * That keeps the store ignorant of consent, which is also what keeps it
 * replaceable.
 */
export interface ClaimInput {
  readonly runnerId: string;
  readonly owner: string;
  readonly device: PublicIdentity;
  /**
   * The (site, owner) pairs this device may run work for — cloud_009 §3.
   *
   * **One set of pairs, not a set of sites and a set of owners.** Consent
   * binds a user to a site, so the two cannot travel separately: a device
   * whose owner consented to site A, serving a roster member who consented
   * to site B, would have every element of both sets and no consented route
   * between them. Two sets multiply; consent does not.
   *
   * Built by {@link Projection.routesFor} and matched with {@link routeKey},
   * so the relay and a store in another repository agree on the encoding by
   * calling the same function rather than by both spelling it out.
   *
   * This is the collapse that lets a claim stay one operation: a predicate
   * cannot travel to a store over a network, and a set can.
   */
  readonly routes: ReadonlySet<string>;
  /**
   * Kinds this device has a **default** for, which is what serves an
   * unselected job.
   *
   * Not "kinds it can run": since byollm_016 a device may advertise several
   * services answering one kind, and a job that named none of them must go to
   * the one its owner chose. A kind with two claimants and no default is
   * withheld and does not appear here at all.
   */
  readonly kinds: ReadonlySet<string>;
  /**
   * The (kind, service) pairs this device advertises — byollm_016 Phase B.
   *
   * **One set of pairs, for the reason `routes` above is one set of pairs.**
   * A set of kinds and a set of service names would multiply: a device
   * offering `studio` for `llm.generate` and `claude` for `llm.chat` has both
   * kinds and both names, and the product contains
   * (`llm.chat`, `studio`) — a combination it never advertised and cannot
   * run. Two sets multiply; an advertisement does not.
   *
   * Written with {@link serviceKey}, so a store in another repository agrees
   * on the encoding by calling the same function rather than by both
   * spelling it out.
   */
  readonly serves: ReadonlySet<string>;
  readonly max: number;
  readonly leaseMs: number;
}

/**
 * How a (site, owner) route is written, so two implementations agree.
 *
 * The same `\u0000` the job key uses, for the same reason: it cannot appear
 * in a site id or an owner id, so this is a key rather than a parser.
 */
export const routeKey = (siteId: string, owner: string): string =>
  `${siteId}\u0000${owner}`;

/**
 * How a (kind, service) advertisement is written — byollm_016 Phase B.
 *
 * The same `\u0000` as {@link routeKey} and for the same reason: it cannot
 * appear in a job kind or a service name, so this is a key rather than a
 * parser. One function, called by every party that has to agree.
 */
export const serviceKey = (kind: string, service: string): string =>
  `${kind}\u0000${service}`;

/**
 * Where the store's sense of time comes from — cloud_006 §3.4.
 *
 * **The store owns its clock; callers do not pass one.** Every deadline the
 * relay decides — a lease's expiry, the `awaiting-payload` window, what a
 * sweep considers due — is now stamped by one source, and it is the same
 * source that will later stamp them for every replica.
 *
 * It used to be a parameter. `claim` took `now`, `sweep` took `now`, and each
 * plane called its own `now()` before calling in — which is fine in one
 * process and is the recurring bug the moment there are two. A lease granted
 * by a pod whose clock runs fast is short; the same lease swept by a pod whose
 * clock runs slow outlives it. Nobody is wrong and the lease has no length.
 *
 * A Valkey-backed store returns `TIME` here, so the deadline and the sweep
 * that enforces it are read from the same server. The injected clock stays for
 * tests, which is what lets them move time instead of sleeping.
 *
 * **What deliberately does not use this**: request-signature freshness. That
 * is checked against the *local* clock on purpose — it is a question about the
 * caller's clock versus this process's, `MAX_CLOCK_SKEW_MS` already tolerates
 * two minutes of disagreement, and a network round trip to timestamp every
 * inbound request would be a cost with no property behind it.
 */
export interface RelayStateOptions {
  readonly now?: () => number | Promise<number>;
}

/** Why a lease-scoped operation was refused, in the caller's vocabulary. */
export type HolderRefusal =
  | "not-found"
  | "not-holder"
  | "stale-lease"
  | "not-ready"
  /** The job already ended — V1-6. A replay must not reopen it. */
  | "terminal";

/**
 * In-memory routing state.
 *
 * Deliberately not durable. The skeleton proves the protocol, and the
 * production hub replaces this with the closed multi-tenant router behind the
 * same shape (cloud_004 §9). Anything a restart loses here is a job that
 * returns to its site's queue — which is the behaviour a lapsed lease already
 * has to produce, so nothing new needs to be true for this to be safe.
 */
/**
 * A job's key: the site that published it, and the id that site chose.
 *
 * `\u0000` cannot appear in either half, so this is a key rather than a
 * parser — cloud_009 §3, and the reason the Valkey layout uses a distinct
 * prefix rather than a suffix on the old one.
 */
const keyOf = (siteId: string, jobId: string): string =>
  `${siteId}\u0000${jobId}`;

export class RelayState implements RoutingStore {
  /**
   * Jobs by **(site, id)** — cloud_009 §3.
   *
   * A job id is a site's to choose, so two sites can choose the same one.
   * Keyed by the bare id, the second site's enqueue returned the first
   * site's job (cloud_008 finding 58), and the refusal that fixed it was a
   * cross-tenant existence oracle. Keyed by the pair, the collision does not
   * exist and there is nothing to refuse.
   *
   * `\u0000` as the separator, because a site id is a uuid and a job id is
   * whatever a site chose — including, one day, a string with a colon in it.
   * A separator that cannot appear in either half is the difference between
   * a key and a parser.
   */
  readonly #jobs = new Map<string, RoutedJob>();

  /**
   * Grants by lease id, so a holder-scoped call needs no site — §3.
   *
   * `takePayload`, `complete`, `releaseLeases` and `renewLeases` carry a
   * `leaseId` the relay minted, which is unique across every site. That is
   * what lets those four signatures stay as they are: the caller names the
   * grant, and the grant names the job. A daemon never has to know a site id
   * to answer for work it holds.
   */
  readonly #byLease = new Map<string, RoutedJob>();

  /**
   * Jobs by bare id, across sites — the refusal path.
   *
   * The lease index alone answers the happy case and gets the refusals
   * wrong: a **stale** lease finds nothing, so `LEASE_HONORED`'s "your grant
   * ended" becomes "no such job", and a daemon that was slow is told
   * something untrue about the work it was doing. Distinguishing
   * `not-found`, `not-holder` and `stale-lease` needs the job even when the
   * lease named is over, and that is what this is for.
   *
   * A list rather than a single value: two sites may choose one id, which is
   * the whole reason `#jobs` is keyed by the pair.
   */
  readonly #byJobId = new Map<string, RoutedJob[]>();

  /**
   * The job a holder-scoped call is about, without a site id.
   *
   * The exact grant first, and **checked against the job the caller named**:
   * a lease id belonging to another job would otherwise hand over that job's
   * payload to somebody holding a valid-looking grant. Then the same job held
   * by this runner under an older grant, which is what `stale-lease` is.
   *
   * And then nothing — V1-8. There used to be a third step: any job with that
   * id, which produced `not-holder` where an absent job produces `not-found`.
   * Since job ids are chosen per site, a runner could name a bare id it had
   * no relationship with and learn from the status code whether some *other*
   * tenant had a job by that name. Finding 58's existence oracle, through the
   * holder door.
   *
   * The distinction it bought was never acted on: a daemon abandons the work
   * either way. So a caller now learns about jobs it holds or held, and about
   * nothing else.
   */
  #grantFor(
    jobId: string,
    runnerId: string,
    leaseId: string,
  ): RoutedJob | undefined {
    const exact = this.#byLease.get(leaseId);
    if (exact?.id === jobId) return exact;
    const candidates = this.#byJobId.get(jobId) ?? [];
    return candidates.find((job) => job.claimedBy?.runnerId === runnerId);
  }

  #index(job: RoutedJob): void {
    const bare = this.#byJobId.get(job.id);
    if (bare) {
      if (!bare.includes(job)) bare.push(job);
    } else {
      this.#byJobId.set(job.id, [job]);
    }
  }

  #forget(job: RoutedJob): void {
    this.#jobs.delete(keyOf(job.siteId, job.id));
    const bare = (this.#byJobId.get(job.id) ?? []).filter((it) => it !== job);
    if (bare.length === 0) this.#byJobId.delete(job.id);
    else this.#byJobId.set(job.id, bare);
    if (job.claimedBy) this.#byLease.delete(job.claimedBy.leaseId);
  }
  readonly #presence = new Map<string, Presence>();
  readonly #now: () => number | Promise<number>;

  constructor(options: RelayStateOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** The one clock every deadline in this store is stamped from. */
  async now(): Promise<number> {
    return this.#now();
  }

  /**
   * Take a stub for routing. The payload is not here and will not be.
   *
   * **Idempotent by job id, and that is a security property rather than a
   * convenience.** Site-plane calls are authenticated by signature, and
   * byollm_009 §4.2's argument for signing the request instead of a
   * server-issued nonce rests entirely on every write being idempotent per the
   * instance it names. This one was not: re-enqueueing a known id built a
   * fresh `queued` job over the top of the old one, discarding a live claim,
   * its lease and any payload the site had already sealed to a device. A
   * replayed enqueue inside the two-minute freshness window was therefore a
   * way to yank a job back from the machine running it — the `release` bug of
   * §4.2, rediscovered on the other plane.
   *
   * So a known id returns what is already routing, unchanged. A site that
   * restarts and republishes its queue is the normal case, and it must not
   * disturb work in flight.
   */
  enqueue(input: {
    id: string;
    siteId: string;
    stub: JobStub;
  }): Promise<RoutedJob> {
    // Idempotent by (site, id). The refusal that used to live here went with
    // the collision it refused — cloud_009 §3.
    const existing = this.#jobs.get(keyOf(input.siteId, input.id));
    if (existing) return Promise.resolve(existing);
    const job: RoutedJob = {
      id: input.id,
      siteId: input.siteId,
      stub: input.stub,
      state: "queued",
      refusedBy: [],
    };
    this.#jobs.set(keyOf(job.siteId, job.id), job);
    this.#index(job);
    return Promise.resolve(job);
  }

  job(siteId: string, jobId: string): Promise<RoutedJob | undefined> {
    return Promise.resolve(this.#jobs.get(keyOf(siteId, jobId)));
  }

  jobs(): Promise<RoutedJob[]> {
    return Promise.resolve([...this.#jobs.values()]);
  }

  /** Jobs a site must seal for, right now. */
  async awaiting(siteId: string): Promise<RoutedJob[]> {
    return (await this.jobs()).filter(
      (j) => j.siteId === siteId && j.state === "awaiting-payload",
    );
  }

  /** Sealed results waiting to go home. */
  async finished(siteId: string): Promise<RoutedJob[]> {
    return (await this.jobs()).filter(
      (j) =>
        j.siteId === siteId && j.state === "done" && j.result !== undefined,
    );
  }

  /**
   * Claim work — one operation, because it has to be.
   *
   * Moved here wholesale from `DaemonPlane`, where it was a scan followed by
   * per-job mutation. Nothing about the *decision* changed; what changed is
   * that a store can now implement it, because the filter and the write are
   * one call rather than a loop the caller drives.
   *
   * The order of the guards is worth preserving as-is when this becomes a Lua
   * script: cheapest first, and `owners` last because it is the only one that
   * needed the projection.
   */
  async claim(input: ClaimInput): Promise<ClaimedStub[]> {
    const now = await this.now();
    await this.sweep();

    const granted: ClaimedStub[] = [];
    for (const job of this.#jobs.values()) {
      if (granted.length >= input.max) break;
      if (job.state !== "queued") continue;
      // The route, as one lookup, because consent is about the pair — a
      // device whose owner consented to site A, serving a roster member who
      // consented to site B, is in both a set of sites and a set of owners
      // and has no consented route between them.
      if (!input.routes.has(routeKey(job.siteId, job.stub.owner))) continue;
      // Selection, byollm_016 Phase B. A job naming a service is offered only
      // to a device advertising that exact (kind, service) pair; a job naming
      // none goes to whichever service its owner made the default, which is
      // what `kinds` carries. Never a fallback between the two: a selected
      // job that finds no match waits for a device that has it rather than
      // landing on something else, because silently serving a different
      // service is the substitution NO_PAYLOAD_ROUTING forbids.
      if (
        job.stub.service === undefined
          ? !input.kinds.has(job.stub.kind)
          : !input.serves.has(serviceKey(job.stub.kind, job.stub.service))
      ) {
        continue;
      }
      // Already declined by this device — `REFUSAL_NOT_REOFFERED`, §2.1.
      if (job.refusedBy.includes(input.runnerId)) continue;
      // Withdrawn by the site — §2.2. Cheap, and before every other check.
      if (job.cancelled) continue;
      // The relay's half of AUDIENCE_BOTH_SIDES. The daemon re-checks its own
      // allowlist and may still refuse — this only ever narrows.

      // `self` means the owner's own machines, and the route set cannot
      // express that — cloud_008 §2.1.
      //
      // The routes are every (site, owner) this device may run for, which for
      // a Team owner's machine includes every roster member. Correct for
      // `public` and `named`, and wrong for
      // `self`: a roster member's private job was offered to the owner's
      // daemon, which refused it locally and released it, and the relay
      // offered it straight back. The ping-pong was the visible symptom; the
      // invisible one is that `self` — the audience a user picks *because*
      // they want their own machine — was the audience the relay ignored.
      if (job.stub.audience === "private" && job.stub.owner !== input.owner) {
        continue;
      }

      // A UUID, not a readable composite. The direct plane's lease ids are
      // UUIDs and the Supabase adapter's `lease_id` column is typed `uuid`, so
      // a relay minting `lease_<job>_<time>` would route perfectly against a
      // memory store and fail the moment a real site adopted the lease.
      const leaseId = randomUUID();
      job.state = "awaiting-payload";
      job.claimedBy = {
        runnerId: input.runnerId,
        owner: input.owner,
        device: input.device,
        leaseId,
        leaseExpiresAt: now + input.leaseMs,
      };
      // Not the lease: this bounds how long we wait for a *site*, not how long
      // the device may work. byollm_009 §7.1's third clock.
      job.awaitingUntil = now + AWAITING_PAYLOAD_MS;
      // The grant is findable by its own id, which is how a holder-scoped
      // call needs no site — cloud_009 §3.
      this.#byLease.set(leaseId, job);

      granted.push({
        ...job.stub,
        lease: {
          id: leaseId,
          runnerId: input.runnerId,
          expiresAt: job.claimedBy.leaseExpiresAt,
        },
      });
    }
    return granted;
  }

  /**
   * Hand over the sealed payload to the device that holds the lease.
   *
   * The read and the state transition are one operation for the same reason
   * `claim` is: `running` must be set by whoever was told the envelope, or two
   * replicas can both hand out the same work and both believe they were first.
   */
  takePayload(input: {
    jobId: string;
    runnerId: string;
    leaseId: string;
  }): Promise<{ envelope: SealedEnvelope } | { refused: HolderRefusal }> {
    const job = this.#grantFor(input.jobId, input.runnerId, input.leaseId);
    if (!job) return Promise.resolve({ refused: "not-found" });
    if (job.claimedBy?.runnerId !== input.runnerId) {
      return Promise.resolve({ refused: "not-holder" });
    }
    // LEASE_HONORED per *instance*: a stale lease id names a grant that is
    // over, and answering it would hand work to a previous holder.
    if (job.claimedBy.leaseId !== input.leaseId) {
      return Promise.resolve({ refused: "stale-lease" });
    }
    if (!job.payload) return Promise.resolve({ refused: "not-ready" });
    // Only a job that is still running gets handed its payload — V1-6.
    //
    // The holder and lease checks pass for a job this runner finished
    // moments ago, because completing does not end the grant. A replayed
    // fetch then set `state = 'running'` on a **done** job: `finished()`
    // stopped returning its result to the site, and the sweep requeued
    // completed work as though the device had died holding it. A duplicate
    // request undoing a finished job is the shape `RESULT_IDEMPOTENT` exists
    // to forbid, arriving through the other door.
    if (job.state !== "ready" && job.state !== "running") {
      return Promise.resolve({ refused: "terminal" });
    }
    job.state = "running";
    return Promise.resolve({ envelope: job.payload });
  }

  /**
   * Record a finished job.
   *
   * `RESULT_IDEMPOTENT` lives here rather than in the caller: a replayed
   * result must be a no-op decided by the same operation that would have
   * written it, or two replicas can both decide they were the first.
   */
  complete(input: {
    jobId: string;
    runnerId: string;
    leaseId: string;
    envelope: SealedEnvelope;
    disposition: "ok" | "error" | "canceled";
  }): Promise<
    | { accepted: boolean; duplicate?: boolean; state: RoutedState }
    | { refused: HolderRefusal }
  > {
    const job = this.#grantFor(input.jobId, input.runnerId, input.leaseId);
    if (!job) return Promise.resolve({ refused: "not-found" });
    if (job.claimedBy?.runnerId !== input.runnerId) {
      return Promise.resolve({ refused: "not-holder" });
    }
    // Terminal before holder — cloud_008 §3.6, and the same order in all four
    // stores.
    //
    // This file argued the opposite two days ago: that a result under a grant
    // that ended is a different device's work arriving late rather than a
    // replay, so the lease check should win. That is right for a job which is
    // **not** terminal, and the two orders only ever disagree about a *done*
    // job asked about under a stale grant — where "already recorded" is the
    // more useful of two true statements, and "your lease is stale" invents a
    // worry about an answer that is safely stored.
    //
    // The deciding argument is not comfort. byollm_009 §4's case for signing
    // requests rather than issuing nonces rests on every write being
    // idempotent per the instance it names, and on the direct plane
    // `RESULT_IDEMPOTENT` was holding only because `complete` nulls the lease
    // and the holder check tripped first. A MUST another MUST's security
    // argument leans on cannot hold by coincidence.
    //
    // Scoped to the device that finished it: anyone else falls through to the
    // holder check and gets the refusal they would get for a job that is not
    // terminal, so a job id is not a terminality probe.
    if (job.state === "done") {
      const sameGrant = job.claimedBy.leaseId === input.leaseId;
      return Promise.resolve(
        sameGrant
          ? { accepted: false, duplicate: true, state: job.state }
          : { refused: "stale-lease" },
      );
    }
    // LEASE_HONORED per instance — cloud_008 §1.4a.
    if (job.claimedBy.leaseId !== input.leaseId) {
      return Promise.resolve({ refused: "stale-lease" });
    }
    job.result = input.envelope;
    job.disposition = input.disposition;
    job.state = "done";
    return Promise.resolve({ accepted: true, state: job.state });
  }

  /** Give back leases this runner holds, naming each grant it means. */
  releaseLeases(input: {
    runnerId: string;
    leases: readonly { jobId: string; leaseId: string }[];
    reason?: ReleaseReason;
  }): Promise<string[]> {
    const released: string[] = [];
    for (const { jobId, leaseId } of input.leases) {
      // Through the grant, like every other holder-scoped operation — the
      // caller names a lease and this store no longer keys jobs by a bare id.
      const job = this.#grantFor(jobId, input.runnerId, leaseId);
      if (!job || job.claimedBy?.runnerId !== input.runnerId) continue;
      if (job.claimedBy.leaseId !== leaseId) continue;
      // Recorded before the requeue, so the job goes back to the queue
      // already knowing not to come back here. A daemon releasing for
      // `shutdown` or `backend-down` is saying "not now"; `refused` is the
      // only one that means "not me, ever" — the others must stay claimable
      // by the same device or a restart would strand its own work.
      if (
        input.reason === "refused" &&
        !job.refusedBy.includes(input.runnerId)
      ) {
        job.refusedBy.push(input.runnerId);
      }
      this.#requeue(job);
      released.push(jobId);
    }
    return Promise.resolve(released);
  }

  /**
   * Take a site's sealed payload for a claimed job.
   *
   * Refuses anything not `awaiting-payload`, which is what makes the timeout
   * mean something: a late seal must not land on a claim that has moved.
   */
  seal(input: {
    jobId: string;
    siteId: string;
    envelope: SealedEnvelope;
  }): Promise<
    | { state: RoutedState }
    | { refused: "not-found" | "too-late"; was?: RoutedState }
  > {
    const job = this.#jobs.get(keyOf(input.siteId, input.jobId));
    if (job?.siteId !== input.siteId) {
      return Promise.resolve({ refused: "not-found" });
    }
    if (job.state !== "awaiting-payload") {
      return Promise.resolve({ refused: "too-late", was: job.state });
    }
    job.payload = input.envelope;
    job.state = "ready";
    delete job.awaitingUntil;
    return Promise.resolve({ state: job.state });
  }

  /** {@link RoutingStore.cancel} — the site withdraws a job. */
  cancel(input: { jobId: string; siteId: string }): Promise<boolean> {
    const job = this.#jobs.get(keyOf(input.siteId, input.jobId));
    // Scoped to the caller's site for the same reason every other site-plane
    // operation is: a site must not be able to cancel somebody else's work by
    // guessing an id.
    if (job?.siteId !== input.siteId) return Promise.resolve(false);
    job.cancelled = true;
    // Not deleted, and not requeued. If a device holds it, that device has to
    // hear about it — which is what `cancelRequests` below is for.
    return Promise.resolve(true);
  }

  /** {@link RoutingStore.cancelRequests} — cancelled jobs this runner holds. */
  cancelRequests(runnerId: string): Promise<Grant[]> {
    return Promise.resolve(
      [...this.#jobs.values()]
        .filter(
          (job) =>
            job.cancelled === true && job.claimedBy?.runnerId === runnerId,
        )
        // The grant, not the id — V1-3. Two sites may have chosen the same
        // job id, and a daemon holding both cannot tell which of them a bare
        // id means.
        .map((job) => ({
          jobId: job.id,
          leaseId: job.claimedBy?.leaseId ?? "",
        }))
        .filter((grant) => grant.leaseId !== ""),
    );
  }

  /** {@link RoutingStore.renewLeases} — extend what is still held, name what is not. */
  async renewLeases(input: {
    runnerId: string;
    leases: readonly { jobId: string; leaseId: string }[];
    leaseMs: number;
  }): Promise<{
    renewed: { jobId: string; expiresAt: number }[];
    lost: Grant[];
  }> {
    // The store's clock, not the caller's — cloud_006 §3.4. A lease extended
    // against one replica's `Date.now()` and swept against another's is a
    // lease with no length.
    const now = await this.now();
    const renewed: { jobId: string; expiresAt: number }[] = [];
    const lost: Grant[] = [];

    for (const { jobId, leaseId } of input.leases) {
      const job = this.#grantFor(jobId, input.runnerId, leaseId);
      const held = job?.claimedBy;
      // The lease id *and* the runner. A lease id is a UUID so the runner
      // check is belt and braces, but "this grant, held by you" is the
      // sentence every other operation in this file checks, and a renewal is
      // the one that extends a hold rather than ending it.
      if (
        !job ||
        held?.leaseId !== leaseId ||
        held.runnerId !== input.runnerId
      ) {
        lost.push({ jobId, leaseId });
        continue;
      }
      // Replaced rather than mutated: the grant is a readonly record, which
      // is what stops any other operation here from quietly extending it.
      const expiresAt = now + input.leaseMs;
      job.claimedBy = { ...held, leaseExpiresAt: expiresAt };
      renewed.push({ jobId, expiresAt });
    }

    // `awaitingUntil` is deliberately untouched. That clock bounds how long we
    // wait for a *site* to seal, and a busy device has no bearing on it —
    // byollm_009 §7.1's third clock stays third.
    return { renewed, lost };
  }

  async seen(presence: Omit<Presence, "lastSeenAt">): Promise<Presence> {
    const lastSeenAt = await this.now();
    const existing = this.#presence.get(presence.runnerId);
    if (existing) {
      existing.lastSeenAt = lastSeenAt;
      // Refreshed, not merged. The heartbeat re-sends the whole matrix every
      // time precisely so a server never matches against a stale one, and a
      // record that kept the union would keep advertising a backend the
      // machine has since lost — which is worse than forgetting one it still
      // has, because work would route to it.
      existing.capabilities = presence.capabilities;
      // Refreshed for the same reason and in the same breath: a kind that
      // stopped being contended — because the owner chose a default, or one
      // service went away — must stop being reported as withheld, or the page
      // keeps asking for a decision that has already been made.
      existing.withheld = presence.withheld;
      return existing;
    }
    const fresh: Presence = { ...presence, lastSeenAt };
    this.#presence.set(presence.runnerId, fresh);
    return fresh;
  }

  presence(runnerId: string): Promise<Presence | undefined> {
    return Promise.resolve(this.#presence.get(runnerId));
  }

  /**
   * Lose a record, the way a real store does.
   *
   * A shared store drops presence for reasons this one never will — a TTL, a
   * reschedule, a restart — and the interesting behaviour is what the relay
   * does next. `ValkeyRoutingStore` has carried the same helper since
   * finding 52; this is its memory twin, so the case can be written once
   * against the implementation that is easy to reason about.
   */
  dropPresenceForTests(runnerId: string): Promise<void> {
    this.#presence.delete(runnerId);
    return Promise.resolve();
  }

  everyone(): Promise<Presence[]> {
    return Promise.resolve([...this.#presence.values()]);
  }

  /**
   * Return a job to the queue, forgetting the claim.
   *
   * The stub survives; nothing is lost. That is `LEASE_RECLAIMABLE` and it is
   * why the awaiting-payload timeout is cheap to fire: the worst case is that
   * a device did nothing for ten seconds and another one gets a turn.
   */
  #requeue(job: RoutedJob): void {
    job.state = "queued";
    // The grant ended; the index that names it must end with it, or a stale
    // lease id resolves to a job it no longer holds.
    if (job.claimedBy) this.#byLease.delete(job.claimedBy.leaseId);
    delete job.claimedBy;
    delete job.awaitingUntil;
    delete job.payload;
  }

  /**
   * Fire whatever the clock says is due, and report it.
   *
   * Returns the jobs it requeued so a caller can log or surface them — a
   * timeout that fires invisibly is indistinguishable from a job that was
   * never claimed, and those want very different debugging.
   */
  async sweep(): Promise<RoutedJob[]> {
    const now = await this.now();
    const requeued: RoutedJob[] = [];
    const expired: RoutedJob[] = [];
    for (const job of this.#jobs.values()) {
      // Past its deadline — cloud_008 §2.2, and `TTL_EXPIRY` on this plane.
      //
      // The relay never read `stub.deadlineAt`. Not "read it and got the
      // arithmetic wrong": the field travelled on every stub, byollm_009 §6
      // describes it as the bound on how long a ciphertext is worth carrying,
      // and nothing here ever looked at it. A job whose deadline passed went
      // on being offered to devices forever, and its sealed payload sat in
      // the relay for as long as the process lived.
      //
      // Dropped rather than marked terminal. The relay is a router and the
      // site holds the authoritative record; a stub nobody may run is not
      // routing state, and keeping a tombstone would be keeping the ciphertext
      // with it. A daemon mid-flight learns through `renewLeases`, which
      // reports a job the store no longer holds as `lost` — the path that
      // already exists for a lease that ended.
      if (job.stub.deadlineAt <= now) {
        this.#forget(job);
        expired.push(job);
        continue;
      }
      if (job.state === "awaiting-payload" && (job.awaitingUntil ?? 0) <= now) {
        this.#requeue(job);
        requeued.push(job);
      }
      const lease = job.claimedBy;
      if (
        lease &&
        (job.state === "ready" || job.state === "running") &&
        lease.leaseExpiresAt <= now
      ) {
        this.#requeue(job);
        requeued.push(job);
      }
    }
    // Both, because a caller that logs "requeued" and never mentions expiry
    // would report a shrinking queue with no reason for it.
    return [...requeued, ...expired];
  }
}
