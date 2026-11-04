import type { ClaimedStub, JobStub, SealedEnvelope } from "@byollm/protocol";
import type {
  ClaimInput,
  HolderRefusal,
  OutstandingToolCall,
  Presence,
  ReleaseReason,
  RoutedJob,
  RoutedState,
  ToolCallRefusal,
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
/**
 * One grant, named by both halves — V1-3.
 *
 * A job id is chosen per site, so two sites can pick the same one; the lease
 * id is the unique thing an upstream and a daemon can both point at. Anywhere
 * this store says "this piece of work, held by you", it says it with both.
 */
export interface Grant {
  readonly jobId: string;
  readonly leaseId: string;
}

export interface RoutingStore {
  /** The one clock every deadline in this store is stamped from. */
  now(): Promise<number>;

  /**
   * Take a stub for routing. Idempotent by id, **within a site**.
   *
   * A republished id belonging to the same site returns what is already
   * routing, unchanged: a site that restarts and republishes its queue must
   * not disturb work in flight (byollm_009 §4.2's replay argument rests on
   * it).
   *
   * A republished id belonging to a **different** site is a different job —
   * cloud_009 §3. Keys are `(site, id)`, so two sites choosing one id collide
   * nowhere and there is nothing to refuse.
   *
   * cloud_008 finding 58 closed this by refusing the collision, which was as
   * far as a single-site relay could go and left a cross-tenant existence
   * oracle: a site knows its own stub is well-formed, so any answer it can
   * tell apart from success confirms that somebody else holds that id. The
   * refusal is gone with the collision.
   */
  enqueue(input: {
    id: string;
    siteId: string;
    stub: JobStub;
    /**
     * The job's tool-call budget, from the site, for `llm.tools` only —
     * byollm_012 §8. Kept with the job; absent means the protocol ceiling.
     */
    maxToolCalls?: number;
  }): Promise<RoutedJob>;

  /**
   * One job, named by the site that published it — cloud_009 §3.
   *
   * The site id is a parameter rather than a scan, and the difference is
   * finding eleven wearing a different hat: a reader that finds a job by id
   * alone is a reader that can see every tenant's state through one door,
   * which is exactly the anonymous read the debug page had and lost. The
   * debug page is per-site or it is nothing.
   */
  job(siteId: string, jobId: string): Promise<RoutedJob | undefined>;
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
    | { accepted: boolean; duplicate?: boolean; state: RoutedState }
    | { refused: HolderRefusal }
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
    /**
     * Epoch ms before which this job MUST NOT be offered to this runner
     * again — the rate a transient refusal needs.
     *
     * "Not now" and "not ever" were the only two things a release could say,
     * and a control plane declining a job for something the world can change
     * means neither. Left immediate, the device re-claims at once and is
     * declined again: a spin, and in a deployment one database read per turn
     * of it.
     *
     * A store MUST NOT offer the job to that runner before this moment, and
     * MUST go on offering it to every other device immediately — the whole
     * reason it is not a refusal is that another machine may be the right
     * one.
     */
    retryAfter?: number;
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
    lost: readonly Grant[];
  }>;

  /**
   * The site withdraws a job — cloud_008 §2.2.
   *
   * Returns false when the job is not this site's, which is the same scoping
   * every other site-plane operation carries: a site must not cancel
   * somebody else's work by guessing an id.
   */
  cancel(input: { jobId: string; siteId: string }): Promise<boolean>;

  /**
   * Cancelled jobs this runner is holding, for the heartbeat to report.
   *
   * The relay answered `cancel: []` unconditionally, so a site could not stop
   * a job it had already withdrawn — a device went on running work whose
   * result nobody would accept, on somebody's own machine, at their expense.
   */
  cancelRequests(runnerId: string): Promise<Grant[]>;

  // -- tool calls — byollm_012 §5.2 ----------------------------------------
  //
  // A short-lived row per call in flight, bound to the grant it was made
  // under and gone when that grant ends or the job does. Four operations, one
  // per endpoint, and each is a decision plus its write, as everything above.

  /**
   * Keep one sealed call from the lease's holder, counted against the job.
   *
   * MUST refuse, in this order: an unknown grant (`not-found`), another
   * runner's (`not-holder`), a finished or withdrawn job (`terminal`), a grant
   * that ended (`stale-lease`), a job whose payload was not collected
   * (`not-ready`), a job that is not `llm.tools` (`not-tools`), and the call
   * past the job's budget (`budget`) — counted before the write, over every
   * grant the job has had. A call id already recorded under this grant
   * returns that call with `duplicate` if the envelope is the same, and is
   * refused (`call-conflict`) if it is not; neither is counted again.
   */
  recordToolCall(input: {
    jobId: string;
    runnerId: string;
    leaseId: string;
    callId: string;
    envelope: SealedEnvelope;
  }): Promise<
    | { callId: string; expiresAt: number; duplicate?: true }
    | { refused: ToolCallRefusal }
  >;

  /**
   * This site's outstanding calls: made under a job's current grant, not
   * answered, and not past `TOOL_LIMITS.callTimeoutMs` on this store's clock.
   */
  toolCalls(siteId: string): Promise<OutstandingToolCall[]>;

  /**
   * Keep a site's sealed answer — only for an outstanding call of the same
   * job (`TOOL_ENVELOPES_BOUND`, the upstream's half).
   *
   * `not-found` for a call this job never made, made under a grant that has
   * ended, or of a job that has; `too-late` for one that timed out or was
   * already answered differently. The same answer twice is accepted twice
   * and written once.
   */
  answerToolCall(input: {
    siteId: string;
    jobId: string;
    callId: string;
    envelope: SealedEnvelope;
  }): Promise<{ accepted: true } | { refused: "not-found" | "too-late" }>;

  /**
   * The answered calls among those named, for the runner holding each one's
   * current grant. A call not answered, not this runner's, or under a grant
   * that ended is left out rather than refused.
   */
  toolResults(input: {
    runnerId: string;
    calls: readonly { jobId: string; leaseId: string; callId: string }[];
  }): Promise<
    {
      jobId: string;
      leaseId: string;
      callId: string;
      envelope: SealedEnvelope;
    }[]
  >;

  /** Record a device as present. The store stamps when. */
  seen(presence: Omit<Presence, "lastSeenAt">): Promise<Presence>;
  presence(runnerId: string): Promise<Presence | undefined>;
  everyone(): Promise<Presence[]>;

  /** Fire whatever the clock says is due, and report it. */
  sweep(): Promise<RoutedJob[]>;
}
