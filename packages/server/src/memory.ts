import {
  backendDescriptor,
  matchAudience,
  type Capability,
} from "@byollm/protocol";
import { generateJobId } from "./ids.js";
import type {
  EnqueueInput,
  JobRecord,
  PairingRecord,
  RunnerRecord,
} from "./records.js";
import type {
  ApproveArgs,
  ByollmStore,
  ClaimArgs,
  CompleteArgs,
  CompleteResult,
  ReleaseArgs,
  RenewArgs,
  RenewResult,
  TouchArgs,
} from "./store.js";

/** Tunables an embedder may want to override in tests. */
export interface MemoryStoreOptions {
  /** Default TTL for a job once claimable. */
  readonly defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * The reference store: everything in one process, no persistence.
 *
 * This is not a toy — it is the implementation the conformance kit certifies
 * first, so its semantics *are* the specification's semantics for anything
 * the prose leaves implicit. A SQL adapter is correct when the same kit
 * passes against it.
 *
 * Concurrency: JavaScript's single-threaded turn is the atomicity primitive.
 * `claim` performs its read-decide-write with no `await` inside the critical
 * section, which is what makes {@link MUSTS.CLAIM_ATOMIC} hold here. A SQL
 * adapter gets the same property from `FOR UPDATE SKIP LOCKED`.
 */
export class MemoryStore implements ByollmStore {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #runners = new Map<string, RunnerRecord>();
  readonly #pairings = new Map<string, PairingRecord>();
  /** Job ids the app has asked to cancel, not yet acknowledged by a runner. */
  readonly #cancelRequests = new Set<string>();
  readonly #defaultTtlMs: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  // -- jobs ---------------------------------------------------------------

  create(input: EnqueueInput, now: number): Promise<JobRecord> {
    const id = input.id ?? generateJobId();
    const existing = this.#jobs.get(id);
    // Idempotent by caller-supplied id: re-enqueueing the same id is a no-op,
    // so an app's retry cannot duplicate work (the house "one door" rule).
    if (existing) return Promise.resolve(existing);

    const dependsOn = [...(input.dependsOn ?? [])];
    const blocked = dependsOn.some(
      (depId) => this.#jobs.get(depId)?.state !== "ok",
    );

    const job: JobRecord = {
      id,
      kind: input.kind,
      payload: input.payload,
      audience: input.audience ?? "self",
      owner: input.owner,
      audienceAllow: input.audienceAllow ? [...input.audienceAllow] : undefined,
      dependsOn,
      state: "queued",
      lease: null,
      createdAt: now,
      // The TTL clock starts here only if nothing blocks the job.
      claimableAt: blocked ? null : now,
      ttlMs: input.ttlMs ?? this.#defaultTtlMs,
      deadlineAt: input.deadlineAt ?? null,
      refusedBy: [],
      attempts: 0,
      outcome: null,
      provenance: null,
      updatedAt: now,
    };
    this.#jobs.set(id, job);
    return Promise.resolve(job);
  }

  get(jobId: string): Promise<JobRecord | null> {
    return Promise.resolve(this.#jobs.get(jobId) ?? null);
  }

  claim(args: ClaimArgs): Promise<JobRecord[]> {
    // Sweep first so an expired job is never handed out.
    this.#expireDueSync(args.now);

    const claimed: JobRecord[] = [];
    // Oldest-claimable first: a job that has waited longest goes next.
    const candidates = [...this.#jobs.values()].sort(
      (a, b) => (a.claimableAt ?? Infinity) - (b.claimableAt ?? Infinity),
    );

    for (const job of candidates) {
      if (claimed.length >= args.max) break;
      if (!this.#isClaimable(job, args)) continue;

      const updated: JobRecord = {
        ...job,
        state: "claimed",
        lease: {
          runnerId: args.runnerId,
          expiresAt: args.now + args.leaseMs,
        },
        attempts: job.attempts + 1,
        updatedAt: args.now,
      };
      this.#jobs.set(job.id, updated);
      claimed.push(updated);
    }
    return Promise.resolve(claimed);
  }

  /**
   * The claim predicate, shared by `claim` and the no-runner signal so the
   * two can never disagree about what "a runner that could take this" means.
   */
  #isClaimable(
    job: JobRecord,
    args: Pick<ClaimArgs, "runnerId" | "runnerOwner" | "capabilities" | "now">,
  ): boolean {
    if (job.state !== "queued") return false;
    if (job.claimableAt === null || job.claimableAt > args.now) return false;
    if (job.refusedBy.includes(args.runnerId)) return false;

    const capability = capabilityFor(args.capabilities, job.kind);
    if (!capability) return false;

    const match = matchAudience(
      {
        owner: job.owner,
        audience: job.audience,
        audienceAllow: job.audienceAllow,
      },
      {
        owner: args.runnerOwner,
        offerScope: capability.offerScope,
        // From the registry, not a local guess — the subscription self-lock
        // must mean the same thing on both sides of the wire.
        account: backendDescriptor(capability.backendId).account,
        // The server cannot see a remote daemon's local allowlist and must
        // not pretend to (protocol §4.2). It admits the job here; the daemon
        // is the enforcing side and releases with `refused` if its own list
        // says no.
        locallyAllows: () => true,
      },
    );
    return match.ok;
  }

  renewLeases(args: RenewArgs): Promise<RenewResult> {
    this.#expireDueSync(args.now);

    const renewed: { jobId: string; expiresAt: number }[] = [];
    const lost: string[] = [];

    for (const jobId of args.jobIds) {
      const job = this.#jobs.get(jobId);
      if (!job || job.lease?.runnerId !== args.runnerId) {
        // Either reclaimed by someone else or terminal — either way this
        // runner must stop working on it.
        lost.push(jobId);
        continue;
      }
      if (job.state !== "claimed" && job.state !== "running") {
        lost.push(jobId);
        continue;
      }
      const expiresAt = args.now + args.leaseMs;
      this.#jobs.set(jobId, {
        ...job,
        state: "running",
        lease: { runnerId: args.runnerId, expiresAt },
        updatedAt: args.now,
      });
      renewed.push({ jobId, expiresAt });
    }
    return Promise.resolve({ renewed, lost });
  }

  complete(args: CompleteArgs): Promise<CompleteResult> {
    const job = this.#jobs.get(args.jobId);
    if (!job) return Promise.resolve({ accepted: false, job: null });

    // First terminal outcome wins; a later submission is discarded, not
    // applied ({@link MUSTS.RESULT_IDEMPOTENT}).
    if (
      job.state === "ok" ||
      job.state === "error" ||
      job.state === "canceled"
    ) {
      return Promise.resolve({ accepted: false, job });
    }
    if (job.state === "expired") {
      return Promise.resolve({ accepted: false, job });
    }
    // A runner that lost its lease may not write a result
    // ({@link MUSTS.LEASE_HONORED}).
    if (job.lease?.runnerId !== args.runnerId) {
      return Promise.resolve({ accepted: false, job });
    }

    const state =
      args.outcome.outcome === "ok"
        ? "ok"
        : args.outcome.outcome === "canceled"
          ? "canceled"
          : "error";

    const updated: JobRecord = {
      ...job,
      state,
      lease: null,
      outcome: args.outcome,
      provenance: args.provenance,
      updatedAt: args.now,
    };
    this.#jobs.set(job.id, updated);
    this.#cancelRequests.delete(job.id);

    if (state === "ok") this.#unblockDependents(job.id, args.now);

    return Promise.resolve({ accepted: true, job: updated });
  }

  /**
   * Start the TTL clock on anything this job was blocking.
   *
   * Deliberately only on `ok`: a dependency that errored leaves its dependents
   * blocked forever rather than releasing them into a run whose input never
   * arrived. They expire at their absolute deadline if one was set, and the
   * app sees a chain that stopped where it broke.
   */
  #unblockDependents(completedId: string, now: number): void {
    for (const job of this.#jobs.values()) {
      if (job.claimableAt !== null) continue;
      if (!job.dependsOn.includes(completedId)) continue;
      const ready = job.dependsOn.every(
        (depId) => this.#jobs.get(depId)?.state === "ok",
      );
      if (ready) {
        this.#jobs.set(job.id, { ...job, claimableAt: now, updatedAt: now });
      }
    }
  }

  release(args: ReleaseArgs): Promise<string[]> {
    const released: string[] = [];
    for (const jobId of args.jobIds) {
      const job = this.#jobs.get(jobId);
      if (!job || job.lease?.runnerId !== args.runnerId) continue;

      this.#jobs.set(jobId, {
        ...job,
        state: "queued",
        lease: null,
        // Newly available again, so the TTL clock restarts here too.
        claimableAt: args.now,
        // A refusal is remembered, or the pair spins between claim and
        // release forever ({@link MUSTS.REFUSAL_NOT_REOFFERED}).
        refusedBy:
          args.reason === "refused"
            ? [...new Set([...job.refusedBy, args.runnerId])]
            : job.refusedBy,
        updatedAt: args.now,
      });
      released.push(jobId);
    }
    return Promise.resolve(released);
  }

  expireDue(now: number): Promise<JobRecord[]> {
    return Promise.resolve(this.#expireDueSync(now));
  }

  /**
   * Lease expiry and TTL expiry in one idempotent sweep.
   *
   * Order matters: a lease is reclaimed *before* the TTL is judged, so a job
   * whose runner died is offered again rather than being expired for having
   * sat in `claimed` too long.
   */
  #expireDueSync(now: number): JobRecord[] {
    const changed: JobRecord[] = [];

    for (const job of this.#jobs.values()) {
      if (
        (job.state === "claimed" || job.state === "running") &&
        job.lease !== null &&
        job.lease.expiresAt <= now
      ) {
        const requeued: JobRecord = {
          ...job,
          state: "queued",
          lease: null,
          // The TTL clock restarts: it measures how long a job has waited
          // *unclaimed*, and this job has just become available again. Without
          // this, a job whose runner died would expire for time it spent being
          // actively worked on — losing exactly the work `kill -9` recovery
          // exists to save. Total lifetime is bounded by `deadlineAt`, which
          // is absolute and unaffected by reclaim.
          claimableAt: now,
          updatedAt: now,
        };
        this.#jobs.set(job.id, requeued);
        changed.push(requeued);
      }
    }

    for (const job of this.#jobs.values()) {
      if (job.state !== "queued") continue;
      const pastDeadline = job.deadlineAt !== null && job.deadlineAt <= now;
      const pastTtl =
        job.claimableAt !== null && job.claimableAt + job.ttlMs <= now;
      if (!pastDeadline && !pastTtl) continue;

      const expired: JobRecord = {
        ...job,
        state: "expired",
        lease: null,
        updatedAt: now,
      };
      this.#jobs.set(job.id, expired);
      changed.push(expired);
    }
    return changed;
  }

  cancel(jobId: string, now: number): Promise<JobRecord | null> {
    const job = this.#jobs.get(jobId);
    if (!job) return Promise.resolve(null);
    if (job.state === "queued") {
      const canceled: JobRecord = {
        ...job,
        state: "canceled",
        lease: null,
        updatedAt: now,
      };
      this.#jobs.set(jobId, canceled);
      return Promise.resolve(canceled);
    }
    if (job.state === "claimed" || job.state === "running") {
      // Held by a runner: the cancel travels on the next heartbeat and the
      // runner reports `canceled` itself, so the job's own state waits.
      this.#cancelRequests.add(jobId);
      return Promise.resolve(job);
    }
    return Promise.resolve(job);
  }

  listClaimedBy(runnerId: string): Promise<JobRecord[]> {
    return Promise.resolve(
      [...this.#jobs.values()].filter(
        (job) => job.lease?.runnerId === runnerId,
      ),
    );
  }

  listCancelRequests(runnerId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.#cancelRequests].filter(
        (jobId) => this.#jobs.get(jobId)?.lease?.runnerId === runnerId,
      ),
    );
  }

  // -- pairing and runners -------------------------------------------------

  createPairing(record: PairingRecord): Promise<void> {
    this.#pairings.set(record.deviceCodeHash, record);
    return Promise.resolve();
  }

  getPairingByDeviceCodeHash(hash: string): Promise<PairingRecord | null> {
    return Promise.resolve(this.#pairings.get(hash) ?? null);
  }

  getPairingByUserCode(userCode: string): Promise<PairingRecord | null> {
    for (const pairing of this.#pairings.values()) {
      if (pairing.userCode === userCode) return Promise.resolve(pairing);
    }
    return Promise.resolve(null);
  }

  approvePairing(args: ApproveArgs): Promise<RunnerRecord> {
    const pairing = [...this.#pairings.values()].find(
      (p) => p.userCode === args.userCode,
    );
    if (!pairing) throw new Error(`unknown pairing code: ${args.userCode}`);
    if (pairing.expiresAt <= args.now) {
      throw new Error("pairing code has expired");
    }
    if (pairing.state !== "pending") {
      throw new Error(`pairing is already ${pairing.state}`);
    }

    const runner: RunnerRecord = {
      id: args.runnerId,
      owner: args.owner,
      tokenHash: args.tokenHash,
      label: pairing.label,
      platform: pairing.platform,
      daemonVersion: pairing.daemonVersion,
      capabilities: pairing.capabilities,
      paused: false,
      revokedAt: null,
      lastHeartbeatAt: args.now,
      createdAt: args.now,
    };
    this.#runners.set(runner.id, runner);
    this.#pairings.set(pairing.deviceCodeHash, {
      ...pairing,
      state: "approved",
      owner: args.owner,
      runnerId: runner.id,
      runnerTokenOnce: args.runnerToken,
    });
    return Promise.resolve(runner);
  }

  denyPairing(userCode: string, _now: number): Promise<void> {
    const pairing = [...this.#pairings.values()].find(
      (p) => p.userCode === userCode,
    );
    if (pairing) {
      this.#pairings.set(pairing.deviceCodeHash, {
        ...pairing,
        state: "denied",
      });
    }
    return Promise.resolve();
  }

  consumePairingToken(deviceCodeHash: string): Promise<void> {
    const pairing = this.#pairings.get(deviceCodeHash);
    if (pairing) {
      this.#pairings.set(deviceCodeHash, {
        ...pairing,
        runnerTokenOnce: null,
      });
    }
    return Promise.resolve();
  }

  getRunnerByTokenHash(hash: string): Promise<RunnerRecord | null> {
    for (const runner of this.#runners.values()) {
      if (runner.tokenHash === hash) return Promise.resolve(runner);
    }
    return Promise.resolve(null);
  }

  getRunner(runnerId: string): Promise<RunnerRecord | null> {
    return Promise.resolve(this.#runners.get(runnerId) ?? null);
  }

  touchRunner(args: TouchArgs): Promise<RunnerRecord | null> {
    const runner = this.#runners.get(args.runnerId);
    if (!runner) return Promise.resolve(null);
    const updated: RunnerRecord = {
      ...runner,
      capabilities: args.capabilities,
      daemonVersion: args.daemonVersion,
      paused: args.paused,
      lastHeartbeatAt: args.now,
    };
    this.#runners.set(runner.id, updated);
    return Promise.resolve(updated);
  }

  revokeRunner(runnerId: string, now: number): Promise<void> {
    const runner = this.#runners.get(runnerId);
    // Revocation is one-way: an already-revoked runner keeps its first
    // revocation time rather than being re-stamped.
    if (runner?.revokedAt === null) {
      this.#runners.set(runnerId, { ...runner, revokedAt: now });
    }
    return Promise.resolve();
  }

  listRunners(owner?: string): Promise<RunnerRecord[]> {
    const all = [...this.#runners.values()];
    return Promise.resolve(
      owner === undefined ? all : all.filter((r) => r.owner === owner),
    );
  }

  // -- test/demo helpers ---------------------------------------------------

  /** All jobs, for demos and assertions. Not part of the store interface. */
  allJobs(): JobRecord[] {
    return [...this.#jobs.values()];
  }
}

/** The capability that would serve a kind, if any. */
export function capabilityFor(
  capabilities: readonly Capability[],
  kind: string,
): Capability | undefined {
  return capabilities.find((c) => c.kind === kind);
}
