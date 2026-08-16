import type {
  Capability,
  JobOutcome,
  ResultProvenance,
} from "@byollm/protocol";
import type {
  StoredJobInput,
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
  create(input: StoredJobInput, now: number): Promise<JobRecord>;

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
  /**
   * Record a lease granted by an upstream this store does not own.
   *
   * The cloud lane's one addition to the store contract, and it exists
   * because of a question the direct plane never has to answer: **who grants
   * the lease?** On the direct plane the site is the upstream, so `claim`
   * both selects the job and grants the lease in one atomic step. Through a
   * relay the relay selects and grants, and the site finds out afterwards.
   *
   * Without this the site's own row stays `queued` while a device is
   * actively running the work, which breaks two things that are not
   * cosmetic: `complete` refuses the result because no lease matches
   * ({@link MUSTS.LEASE_HONORED} enforced against a lease that was never
   * recorded), and `expireDue` expires a job someone is in the middle of.
   *
   * Not a second grant: it records one, and returns `null` if the job is not
   * in a state that can accept it. The authority over who holds what remains
   * the upstream that granted it — a store adopting a lease is bookkeeping,
   * not a decision.
   */
  adopt(args: AdoptArgs): Promise<JobRecord | null>;

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

/** What an upstream tells a store it has granted. */
export interface AdoptArgs {
  readonly jobId: string;
  /**
   * The lease, by its own id — and deliberately **not** a runner id.
   *
   * A relayed device is not this site's runner. It never paired here, the
   * site holds no token for it and cannot revoke it, and `byollm_runners` is
   * a table of machines this site has a relationship with. Fabricating a row
   * to satisfy a foreign key would manufacture a record the site cannot act
   * on, which is worse than not having one.
   *
   * What the site legitimately knows is that the job is out on a lease
   * granted by an upstream, and when that lease ends. Identity of the machine
   * that ran it arrives with the result, proved by a signature — which is a
   * stronger claim than a row anyway.
   */
  readonly leaseId: string;
  readonly expiresAt: number;
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

/**
 * Which grant is being completed — the `LEASE_HONORED` guard, as a shape.
 *
 * A discriminated union rather than two optional fields, because the earlier
 * version was safe only by data: it read "match the runner, unless a lease id
 * was supplied", and a caller supplying neither would have matched
 * `undefined === undefined` and written a result into a job it never held.
 * Nothing did that, and nothing was going to — but the type permitted it, and
 * this codebase has spent a week learning that a permitted mistake is a
 * scheduled one.
 *
 * Two ways to name a holder because there are two planes. A direct runner
 * paired with this site and is known by id. A relayed device never did, and
 * is known only by the grant it holds — which is the more exact check anyway:
 * `LEASE_HONORED` is a statement about a lease instance, the lesson the
 * release endpoint learned when a replayed release yanked a later grant.
 */
export type CompleteHolder =
  | { readonly by: "runner"; readonly runnerId: string }
  | { readonly by: "lease"; readonly leaseId: string };

export interface CompleteArgs {
  readonly jobId: string;
  /** Who claims to hold this job. Both variants are checked, never trusted. */
  readonly holder: CompleteHolder;
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
