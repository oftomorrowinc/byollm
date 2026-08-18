import type { ClaimedStub, JobStub, SealedEnvelope } from "@byollm/protocol";
import type {
  ClaimInput,
  HolderRefusal,
  Presence,
  ReleaseReason,
  RoutedJob,
  RoutedState,
} from "./state.js";

/**
 * What the relay needs from a place to keep routing state — cloud_006 §3.2.
 *
 * `RelayState` implements this in memory and is the reference; a Valkey-backed
 * store implements the same thing across replicas. The interface exists so the
 * relay depends on the *contract* rather than on either, and so the properties
 * below are stated once rather than rediscovered per implementation.
 *
 * ## Every method is a decision plus its write
 *
 * Not one is a read the caller follows with a mutation. That is the whole
 * design, and it is not a style preference: `claim` used to be
 * `jobs()` → filter → mutate in the plane, which is atomic for exactly one
 * reason — Node is single-threaded and the Maps are local. Neither survives a
 * store on a network, and `packages/relay/test/two-replicas.test.ts` holds the
 * resulting race as a failing assertion.
 *
 * **The rule for anything added here:** if a caller has to read, decide, and
 * write back, the operation is in the wrong place. Move the decision in.
 *
 * ## What an implementation must guarantee
 *
 * 1. **`claim` is atomic.** Two callers claiming concurrently must not both
 *    receive the same job. `CLAIM_ATOMIC` is a protocol MUST.
 * 2. **`enqueue` is idempotent by job id.** A known id returns what is already
 *    routing rather than rebuilding it — byollm_009 §4.2's replay argument
 *    rests on every write being idempotent per the instance it names.
 * 3. **`complete` is idempotent.** A replayed result changes nothing, and the
 *    decision is made by the same operation that would have written it.
 * 4. **Lease-scoped operations name the grant.** `takePayload`, `complete` and
 *    `releaseLeases` check the lease *id*, not just the runner — a runner
 *    survives a claim-release-reclaim cycle and a grant does not.
 * 5. **`now()` is the only clock.** Every deadline the store stamps and every
 *    deadline it enforces come from here (§3.4). An implementation backed by a
 *    server returns that server's time, so two replicas cannot disagree about
 *    how long a lease is.
 *
 * ## What it must not do
 *
 * Hold a key, or learn about consent. `claim` takes `owners` as data because a
 * predicate cannot travel to Valkey — and the effect is that the store cannot
 * express an opinion about who may route, only about what it was told. That is
 * what keeps `RELAY_BLIND` a property of the shape rather than of the code.
 */
export interface RoutingStore {
  /** The one clock every deadline in this store is stamped from. */
  now(): Promise<number>;

  /** Take a stub for routing. Idempotent by id. */
  enqueue(input: {
    id: string;
    siteId: string;
    stub: JobStub;
  }): Promise<RoutedJob>;

  job(jobId: string): Promise<RoutedJob | undefined>;
  jobs(): Promise<RoutedJob[]>;

  /** Jobs a site must seal for, right now. */
  awaiting(siteId: string): Promise<RoutedJob[]>;
  /** Sealed results waiting to go home. */
  finished(siteId: string): Promise<RoutedJob[]>;

  /** Grant work to a device — one operation, because it has to be. */
  claim(input: ClaimInput): Promise<ClaimedStub[]>;

  /** Hand the sealed payload to the device that holds the lease. */
  takePayload(input: {
    jobId: string;
    runnerId: string;
    leaseId: string;
  }): Promise<{ envelope: SealedEnvelope } | { refused: HolderRefusal }>;

  /** Record a finished job. Idempotent. */
  complete(input: {
    jobId: string;
    runnerId: string;
    /**
     * The grant the result was produced under — cloud_008 §1.4a.
     *
     * `takePayload` and `releaseLeases` have always checked this and said why;
     * the operation that *writes* checked only the runner, which survives a
     * claim-release-reclaim cycle.
     */
    leaseId: string;
    envelope: SealedEnvelope;
    disposition: "ok" | "error" | "canceled";
  }): Promise<
    { accepted: boolean; state: RoutedState } | { refused: HolderRefusal }
  >;

  /** Give back the grants this runner names. */
  releaseLeases(input: {
    runnerId: string;
    leases: readonly { jobId: string; leaseId: string }[];
    /**
     * Why — cloud_008 §2.1. `refused` MUST be remembered and that job MUST
     * NOT be offered to that runner again (`REFUSAL_NOT_REOFFERED`); every
     * other reason means "not now" and must leave the job claimable by the
     * same device, or a restart would strand its own work.
     */
    reason?: ReleaseReason;
  }): Promise<string[]>;

  /** Take a site's sealed payload for a claimed job. */
  seal(input: {
    jobId: string;
    siteId: string;
    envelope: SealedEnvelope;
  }): Promise<
    | { state: RoutedState }
    | { refused: "not-found" | "too-late"; was?: RoutedState }
  >;

  /**
   * Extend the leases this runner still holds, and name the ones it does not.
   *
   * One call because it is one question — cloud_008 §0.6. This was
   * `lostLeases`, which answered only the second half, and the relay's
   * heartbeat answered the first half with the literal `leases: []`. A daemon
   * was therefore told, every few seconds, that none of its work had been
   * renewed; the sweep requeued at `leaseMs` regardless of how alive the
   * device was, and any job that took longer than a lease was handed to
   * somebody else while the first device was still running it. The direct
   * plane has always renewed here (`handlers.ts` §3), so this was also the two
   * upstreams disagreeing about a rule the daemon cannot see.
   *
   * Renewal and loss come from one read of one state: asked separately they
   * are two answers to "who holds this now", and under two replicas they can
   * differ.
   */
  renewLeases(input: {
    runnerId: string;
    leases: readonly { jobId: string; leaseId: string }[];
    leaseMs: number;
  }): Promise<{
    renewed: readonly { jobId: string; expiresAt: number }[];
    lost: readonly string[];
  }>;

  /** Record a device as present. The store stamps when. */
  seen(presence: Omit<Presence, "revoked" | "lastSeenAt">): Promise<Presence>;
  presence(runnerId: string): Promise<Presence | undefined>;
  everyone(): Promise<Presence[]>;

  /** Fire whatever the clock says is due, and report it. */
  sweep(): Promise<RoutedJob[]>;
}
