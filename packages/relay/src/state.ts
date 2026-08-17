import type {
  ClaimedStub,
  JobStub,
  PublicIdentity,
  SealedEnvelope,
} from "@byollm/protocol";
import { randomUUID } from "node:crypto";

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
  /** Set on revocation so the next request is refused rather than routed. */
  revoked: boolean;
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
  /** The site this relay routes for. Multi-tenancy widens this to a set. */
  readonly siteId: string;
  /** Job kinds this device can actually run. */
  readonly kinds: ReadonlySet<string>;
  /** Whose work it may run — the projection, already collapsed to data. */
  readonly owners: ReadonlySet<string>;
  readonly max: number;
  readonly leaseMs: number;
  readonly now: number;
}

/** Why a lease-scoped operation was refused, in the caller's vocabulary. */
export type HolderRefusal =
  "not-found" | "not-holder" | "stale-lease" | "not-ready";

/**
 * In-memory routing state.
 *
 * Deliberately not durable. The skeleton proves the protocol, and the
 * production hub replaces this with the closed multi-tenant router behind the
 * same shape (cloud_004 §9). Anything a restart loses here is a job that
 * returns to its site's queue — which is the behaviour a lapsed lease already
 * has to produce, so nothing new needs to be true for this to be safe.
 */
export class RelayState {
  readonly #jobs = new Map<string, RoutedJob>();
  readonly #presence = new Map<string, Presence>();

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
    const existing = this.#jobs.get(input.id);
    if (existing) return Promise.resolve(existing);
    const job: RoutedJob = {
      id: input.id,
      siteId: input.siteId,
      stub: input.stub,
      state: "queued",
    };
    this.#jobs.set(job.id, job);
    return Promise.resolve(job);
  }

  job(jobId: string): Promise<RoutedJob | undefined> {
    return Promise.resolve(this.#jobs.get(jobId));
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
    await this.sweep(input.now);

    const granted: ClaimedStub[] = [];
    for (const job of this.#jobs.values()) {
      if (granted.length >= input.max) break;
      if (job.state !== "queued") continue;
      // Only this relay's site. A device paired against one site's key and
      // pinned it; a job from another site could only ever produce an envelope
      // it refuses to open — contained by the crypto, and still a burned job.
      if (job.siteId !== input.siteId) continue;
      if (!input.kinds.has(job.stub.kind)) continue;
      // The relay's half of AUDIENCE_BOTH_SIDES. The daemon re-checks its own
      // allowlist and may still refuse — this only ever narrows.
      if (!input.owners.has(job.stub.owner)) continue;

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
        leaseExpiresAt: input.now + input.leaseMs,
      };
      // Not the lease: this bounds how long we wait for a *site*, not how long
      // the device may work. byollm_009 §7.1's third clock.
      job.awaitingUntil = input.now + AWAITING_PAYLOAD_MS;

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
    const job = this.#jobs.get(input.jobId);
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
    envelope: SealedEnvelope;
    disposition: "ok" | "error" | "canceled";
  }): Promise<
    { accepted: boolean; state: RoutedState } | { refused: HolderRefusal }
  > {
    const job = this.#jobs.get(input.jobId);
    if (!job) return Promise.resolve({ refused: "not-found" });
    if (job.claimedBy?.runnerId !== input.runnerId) {
      return Promise.resolve({ refused: "not-holder" });
    }
    if (job.state === "done") {
      return Promise.resolve({ accepted: false, state: job.state });
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
  }): Promise<string[]> {
    const released: string[] = [];
    for (const { jobId, leaseId } of input.leases) {
      const job = this.#jobs.get(jobId);
      if (!job || job.claimedBy?.runnerId !== input.runnerId) continue;
      if (job.claimedBy.leaseId !== leaseId) continue;
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
    const job = this.#jobs.get(input.jobId);
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

  /** Which of these leases this runner no longer holds. */
  lostLeases(
    runnerId: string,
    active: readonly { jobId: string; leaseId: string }[],
  ): Promise<string[]> {
    void runnerId;
    return Promise.resolve(
      active
        .filter(({ jobId, leaseId }) => {
          const job = this.#jobs.get(jobId);
          return job?.claimedBy?.leaseId !== leaseId;
        })
        .map(({ jobId }) => jobId),
    );
  }

  seen(presence: Omit<Presence, "revoked">): Promise<Presence> {
    const existing = this.#presence.get(presence.runnerId);
    if (existing) {
      existing.lastSeenAt = presence.lastSeenAt;
      return Promise.resolve(existing);
    }
    const fresh: Presence = { ...presence, revoked: false };
    this.#presence.set(presence.runnerId, fresh);
    return Promise.resolve(fresh);
  }

  presence(runnerId: string): Promise<Presence | undefined> {
    return Promise.resolve(this.#presence.get(runnerId));
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
  sweep(now: number): Promise<RoutedJob[]> {
    const requeued: RoutedJob[] = [];
    for (const job of this.#jobs.values()) {
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
    return Promise.resolve(requeued);
  }
}
