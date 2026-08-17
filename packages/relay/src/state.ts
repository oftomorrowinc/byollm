import type { JobStub, PublicIdentity, SealedEnvelope } from "@byollm/protocol";

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
  enqueue(input: { id: string; siteId: string; stub: JobStub }): RoutedJob {
    const existing = this.#jobs.get(input.id);
    if (existing) return existing;
    const job: RoutedJob = {
      id: input.id,
      siteId: input.siteId,
      stub: input.stub,
      state: "queued",
    };
    this.#jobs.set(job.id, job);
    return job;
  }

  job(jobId: string): RoutedJob | undefined {
    return this.#jobs.get(jobId);
  }

  jobs(): RoutedJob[] {
    return [...this.#jobs.values()];
  }

  /** Jobs a site must seal for, right now. */
  awaiting(siteId: string): RoutedJob[] {
    return this.jobs().filter(
      (j) => j.siteId === siteId && j.state === "awaiting-payload",
    );
  }

  /** Sealed results waiting to go home. */
  finished(siteId: string): RoutedJob[] {
    return this.jobs().filter(
      (j) =>
        j.siteId === siteId && j.state === "done" && j.result !== undefined,
    );
  }

  seen(presence: Omit<Presence, "revoked">): Presence {
    const existing = this.#presence.get(presence.runnerId);
    if (existing) {
      existing.lastSeenAt = presence.lastSeenAt;
      return existing;
    }
    const fresh: Presence = { ...presence, revoked: false };
    this.#presence.set(presence.runnerId, fresh);
    return fresh;
  }

  presence(runnerId: string): Presence | undefined {
    return this.#presence.get(runnerId);
  }

  everyone(): Presence[] {
    return [...this.#presence.values()];
  }

  /**
   * Return a job to the queue, forgetting the claim.
   *
   * The stub survives; nothing is lost. That is `LEASE_RECLAIMABLE` and it is
   * why the awaiting-payload timeout is cheap to fire: the worst case is that
   * a device did nothing for ten seconds and another one gets a turn.
   */
  requeue(job: RoutedJob): void {
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
  sweep(now: number): RoutedJob[] {
    const requeued: RoutedJob[] = [];
    for (const job of this.#jobs.values()) {
      if (job.state === "awaiting-payload" && (job.awaitingUntil ?? 0) <= now) {
        this.requeue(job);
        requeued.push(job);
      }
      const lease = job.claimedBy;
      if (
        lease &&
        (job.state === "ready" || job.state === "running") &&
        lease.leaseExpiresAt <= now
      ) {
        this.requeue(job);
        requeued.push(job);
      }
    }
    return requeued;
  }
}
