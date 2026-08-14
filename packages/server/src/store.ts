import type {
  Capability,
  JobOutcome,
  ResultProvenance,
} from "@byollm/protocol";
import type {
  EnqueueInput,
  JobRecord,
  PairingRecord,
  RunnerRecord,
} from "./records.js";

/**
 * The adapter seam.
 *
 * Everything in `@byollm/server` above this interface is storage-agnostic;
 * everything below it is one adapter. `MemoryJobStore` is the reference
 * implementation and the thing the conformance kit certifies first — an
 * adapter is correct when the same kit passes against it.
 */
export interface JobStore {
  /** Create a job. Idempotent when `input.id` is supplied and already exists. */
  create(input: EnqueueInput, now: number): Promise<JobRecord>;

  get(jobId: string): Promise<JobRecord | null>;

  /**
   * Atomically claim up to `max` jobs for a runner
   * ({@link MUSTS.CLAIM_ATOMIC}).
   *
   * An implementation MUST apply, inside the same atomic step:
   * - state is `queued`;
   * - `claimableAt` is non-null and `<= now` (dependencies satisfied,
   *   {@link MUSTS.DEPENDS_ON_GATING});
   * - the job's kind appears in `capabilities`
   *   ({@link MUSTS.CLAIM_REQUIRES_CAPABILITY});
   * - the audience rules admit this runner
   *   ({@link MUSTS.AUDIENCE_BOTH_SIDES});
   * - `runnerId` is not in the job's `refusedBy`
   *   ({@link MUSTS.REFUSAL_NOT_REOFFERED}).
   *
   * SQL-backed adapters SHOULD use `FOR UPDATE SKIP LOCKED`.
   */
  claim(args: ClaimArgs): Promise<JobRecord[]>;

  /**
   * Renew leases for the jobs a runner believes it holds, and report which it
   * has lost. A job whose lease expired un-renewed returns to `queued`
   * ({@link MUSTS.LEASE_RECLAIMABLE}).
   */
  renewLeases(args: RenewArgs): Promise<RenewResult>;

  /**
   * Record a terminal outcome. Idempotent by job id: the first terminal
   * outcome wins ({@link MUSTS.RESULT_IDEMPOTENT}).
   *
   * Recording `ok` MUST also unblock dependents whose remaining dependencies
   * are all `ok`, setting their `claimableAt` — which is when their TTL clock
   * starts ({@link MUSTS.TTL_EXPIRY}).
   */
  complete(args: CompleteArgs): Promise<CompleteResult>;

  /**
   * Return jobs to `queued`. When `reason` is `refused`, the runner MUST be
   * added to each job's `refusedBy`.
   */
  release(args: ReleaseArgs): Promise<string[]>;

  /**
   * Move every claimable-but-unclaimed job past its TTL, and every job past
   * its absolute deadline, to `expired`. Returns what changed.
   *
   * Called opportunistically by the handlers; an adapter MAY also run it on a
   * schedule. It MUST be idempotent — firing twice is always safe.
   */
  expireDue(now: number): Promise<JobRecord[]>;

  /** Cancel a job by app request. Returns the job, or null if unknown. */
  cancel(jobId: string, now: number): Promise<JobRecord | null>;

  /** Jobs a runner currently holds — used to build the heartbeat cancel list. */
  listClaimedBy(runnerId: string): Promise<JobRecord[]>;

  /** Jobs awaiting cancellation that a given runner holds. */
  listCancelRequests(runnerId: string): Promise<string[]>;
}

export interface ClaimArgs {
  readonly runnerId: string;
  /** The runner's owner, for audience matching. */
  readonly runnerOwner: string;
  readonly capabilities: readonly Capability[];
  readonly max: number;
  readonly leaseMs: number;
  readonly now: number;
}

/** A lease named by its grant, not only by the job it covers. */
export interface LeaseRef {
  readonly jobId: string;
  readonly leaseId: string;
}

export interface RenewArgs {
  readonly runnerId: string;
  readonly leases: readonly LeaseRef[];
  readonly leaseMs: number;
  readonly now: number;
}

export interface RenewResult {
  readonly renewed: readonly { jobId: string; expiresAt: number }[];
  /** Jobs the runner claimed to hold but no longer does. */
  readonly lost: readonly string[];
}

export interface CompleteArgs {
  readonly jobId: string;
  readonly runnerId: string;
  readonly outcome: JobOutcome;
  readonly provenance: ResultProvenance;
  readonly now: number;
}

export interface CompleteResult {
  /** False when this submission lost an idempotency race or the lease was gone. */
  readonly accepted: boolean;
  readonly job: JobRecord | null;
}

export interface ReleaseArgs {
  readonly runnerId: string;
  readonly leases: readonly LeaseRef[];
  readonly reason:
    "shutdown" | "pause" | "revoked" | "backend-down" | "refused";
  readonly now: number;
}

/** Runner registry and pairing state. */
export interface RunnerStore {
  /** Begin a device-code pairing. */
  createPairing(record: PairingRecord): Promise<void>;

  getPairingByDeviceCodeHash(hash: string): Promise<PairingRecord | null>;

  getPairingByUserCode(userCode: string): Promise<PairingRecord | null>;

  /**
   * Approve a pairing on behalf of an authenticated user, creating the
   * runner. The `owner` MUST come from the approving user's own session — a
   * daemon can never assert who it is ({@link MUSTS.PAIR_ONE_USER}).
   */
  approvePairing(args: ApproveArgs): Promise<RunnerRecord>;

  denyPairing(userCode: string, now: number): Promise<void>;

  /** Clear the one-shot token after the daemon collects it. */
  consumePairingToken(deviceCodeHash: string): Promise<void>;

  getRunnerByTokenHash(hash: string): Promise<RunnerRecord | null>;

  getRunner(runnerId: string): Promise<RunnerRecord | null>;

  /** Record a heartbeat: capabilities, version, pause state, liveness. */
  touchRunner(args: TouchArgs): Promise<RunnerRecord | null>;

  /** Revoke a runner. Once revoked, never un-revoked. */
  revokeRunner(runnerId: string, now: number): Promise<void>;

  /** Live runners for an owner — used by the no-runner signal. */
  listRunners(owner?: string): Promise<RunnerRecord[]>;

  /**
   * Watch one job for state changes — the push seam (byollm_009 §8.3).
   *
   * **Required of every adapter, from day one, even though v1 uses it only
   * for result readiness.** byollm_006 located streaming's real difficulty at
   * the server→app leg: polling cannot carry deltas by construction. If the
   * store contract were request/response only, adding streaming later would
   * force a *second* adapter-breaking reshape — so the channel exists now and
   * gets one more use later, rather than the interface changing twice.
   *
   * The handler is called after a change lands; it is a signal, not a
   * payload, so a missed or duplicated call is survivable and the caller
   * re-reads. That looseness is deliberate: it is the weakest contract every
   * plausible backend can honour, and a stronger one would exclude adapters
   * for no gain.
   *
   * Returns an unsubscribe function. Calling it twice MUST be safe.
   */
  subscribe(jobId: string, onChange: () => void): () => void;
}

export interface ApproveArgs {
  readonly userCode: string;
  /** From the approving user's session, never from the daemon. */
  readonly owner: string;
  readonly runnerId: string;
  readonly runnerToken: string;
  readonly tokenHash: string;
  readonly now: number;
}

export interface TouchArgs {
  readonly runnerId: string;
  readonly capabilities: readonly Capability[];
  readonly daemonVersion: string;
  readonly paused: boolean;
  readonly now: number;
}

/** A store providing both halves. Most adapters implement one object. */
export interface ByollmStore extends JobStore, RunnerStore {}
