import {
  backendDescriptor,
  matchAudience,
  type DeliveredResult,
  type JobKind,
} from "@byollm/protocol";
import {
  PollingDelivery,
  type PollingDeliveryDeps,
  type ResultDelivery,
  type WaitOptions,
} from "./delivery.js";
import { generateRunnerId, generateRunnerToken, hashSecret } from "./ids.js";
import type { EnqueueInput, JobRecord, RunnerRecord } from "./records.js";
import type { ByollmStore } from "./store.js";

/**
 * How long since a runner's last heartbeat before it stops counting as live.
 * Three heartbeats of slack at the daemon's ~10s cadence.
 */
const DEFAULT_LIVENESS_MS = 35_000;

/** Why a job cannot presently run. */
export type NoRunnerReason =
  | "no-runner-paired"
  | "no-runner-online"
  | "no-matching-capability"
  | "audience-admits-nobody";

/**
 * The no-runner signal (byollm_001 Rev 1 §D).
 *
 * `available: false` means an app should fall back — hosted model, "start
 * your runner" prompt — rather than awaiting something that will never
 * resolve. A job still blocked on dependencies is **not** unavailable; it is
 * waiting, and saying otherwise would make every multi-job flow look broken
 * ({@link MUSTS.NO_RUNNER_SIGNAL}).
 */
export interface RunnerAvailability {
  readonly available: boolean;
  readonly reason?: NoRunnerReason;
  /** Live runners that could take work of this shape. */
  readonly candidates: number;
}

export interface AvailabilityQuery {
  readonly kind: JobKind;
  readonly owner: string;
  readonly audience?: "self" | "named" | "public";
  readonly audienceAllow?: readonly string[];
}

export interface ByollmAppOptions {
  readonly store: ByollmStore;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Liveness window for the no-runner signal. */
  readonly livenessMs?: number;
  /**
   * How the app learns a job finished. Defaults to polling the store, which
   * is correct everywhere; the Supabase adapter substitutes Realtime.
   */
  readonly delivery?: (deps: PollingDeliveryDeps) => ResultDelivery;
  /**
   * How long a sustained no-runner signal must persist before `result()`
   * gives up. Longer tolerates a daemon restarting; shorter fails faster.
   */
  readonly noRunnerGraceMs?: number;
}

/**
 * An enqueued job, with the delivery channel attached.
 *
 * `result()` is sugar over the channel — with a timeout and a
 * `noRunnerAvailable` path — never a bare promise that can hang forever
 * (byollm_003 Rev 1).
 */
export interface JobHandle {
  readonly id: string;
  /** The job as stored at enqueue time. */
  readonly record: JobRecord;
  /** Wait for a terminal outcome. */
  result(options?: WaitOptions): Promise<DeliveredResult>;
  /** Ask the runner to stop. */
  cancel(): Promise<void>;
}

/**
 * The app-facing half of `@byollm/server`.
 *
 * The daemon talks to {@link ByollmHandlers}; the app talks to this. Keeping
 * them separate is what makes "one door per state write" hold — an app
 * enqueues and cancels through these methods and never writes job rows by
 * hand.
 */
export class ByollmApp {
  readonly #store: ByollmStore;
  readonly #now: () => number;
  readonly #livenessMs: number;
  readonly #delivery: ResultDelivery;

  constructor(options: ByollmAppOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#livenessMs = options.livenessMs ?? DEFAULT_LIVENESS_MS;

    const deps: PollingDeliveryDeps = {
      ...(options.noRunnerGraceMs === undefined
        ? {}
        : { graceMs: options.noRunnerGraceMs }),
      read: (jobId) => this.result(jobId),
      availability: async (jobId) => {
        const job = await this.#store.get(jobId);
        if (!job)
          return { available: false, reason: "unknown-job", blocked: false };
        // A job waiting on a dependency is waiting, not unavailable.
        if (job.claimableAt === null) {
          return { available: true, blocked: true };
        }
        const availability = await this.runnerAvailability({
          kind: job.kind,
          owner: job.owner,
          audience: job.audience,
          ...(job.audienceAllow === undefined
            ? {}
            : { audienceAllow: job.audienceAllow }),
        });
        return {
          available: availability.available,
          ...(availability.reason === undefined
            ? {}
            : { reason: availability.reason }),
          blocked: false,
        };
      },
    };
    this.#delivery = options.delivery?.(deps) ?? new PollingDelivery(deps);
  }

  /**
   * Enqueue a job.
   *
   * `audience` defaults to `self` — the safe direction. Widening it means the
   * result comes back marked untrusted (see {@link ByollmApp.result}), and
   * the app is obliged to disclose that to whoever reads it.
   */
  async enqueue(input: EnqueueInput): Promise<JobHandle> {
    const record = await this.#store.create(input, this.#now());
    return {
      id: record.id,
      record,
      result: (options?: WaitOptions) =>
        this.#delivery.waitFor(record.id, options),
      cancel: async () => {
        await this.cancel(record.id);
      },
    };
  }

  /** Read a job's current state. */
  async job(jobId: string): Promise<JobRecord | null> {
    await this.#store.expireDue(this.#now());
    return this.#store.get(jobId);
  }

  /**
   * A job's result with its provenance attached.
   *
   * Check `provenance.untrusted` before rendering. It is true for every
   * `named`/`public` job, because that text came from someone else's machine
   * and the app must not present it as its own AI's answer
   * ({@link MUSTS.RESULT_PROVENANCE}).
   */
  async result(jobId: string): Promise<DeliveredResult | null> {
    const job = await this.job(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      state: job.state,
      ...(job.outcome === null ? {} : { outcome: job.outcome }),
      ...(job.provenance === null ? {} : { provenance: job.provenance }),
    };
  }

  /** Ask a runner to stop. Queued jobs cancel at once; held jobs at the next heartbeat. */
  async cancel(jobId: string): Promise<JobRecord | null> {
    return this.#store.cancel(jobId, this.#now());
  }

  /**
   * Is there a live runner that could take a job of this shape?
   *
   * Runs the identical {@link matchAudience} rule the claim path uses, so the
   * signal cannot promise a runner the claim would then refuse.
   */
  async runnerAvailability(
    query: AvailabilityQuery,
  ): Promise<RunnerAvailability> {
    const now = this.#now();
    const all = await this.#store.listRunners();
    const live = all.filter(
      (runner) =>
        runner.revokedAt === null &&
        !runner.paused &&
        now - runner.lastHeartbeatAt <= this.#livenessMs,
    );

    if (all.length === 0) {
      return { available: false, reason: "no-runner-paired", candidates: 0 };
    }
    if (live.length === 0) {
      return { available: false, reason: "no-runner-online", candidates: 0 };
    }

    let capable = 0;
    let admitted = 0;
    for (const runner of live) {
      const capability = runner.capabilities.find((c) => c.kind === query.kind);
      if (!capability) continue;
      capable += 1;

      const match = matchAudience(
        {
          owner: query.owner,
          audience: query.audience ?? "self",
          audienceAllow: query.audienceAllow,
        },
        {
          owner: runner.owner,
          offerScope: capability.offerScope,
          // A generic backend's cost depends on its base URL, which the
          // server never sees; assume the expensive reading (byollm_007 §4).
          cost: backendDescriptor(capability.backendId).cost ?? "metered",
          // Consent is the daemon's to hold, and it has already applied it:
          // the offer scope arriving here is the *effective* one, so a
          // metered backend nobody agreed to share advertises `self` and is
          // refused by the scope rule above. Re-deriving consent from
          // `false` here would instead refuse every backend an owner
          // deliberately shared, because the server has no way to learn they
          // did — the signal would be wrong in the direction that breaks
          // working setups.
          spend: { acknowledged: true },
          // Same conservative assumption the claim path makes: the server
          // cannot see a remote daemon's local allowlist (protocol §4.2).
          locallyAllows: () => true,
        },
      );
      if (match.ok) admitted += 1;
    }

    if (capable === 0) {
      return {
        available: false,
        reason: "no-matching-capability",
        candidates: 0,
      };
    }
    if (admitted === 0) {
      return {
        available: false,
        reason: "audience-admits-nobody",
        candidates: 0,
      };
    }
    return { available: true, candidates: admitted };
  }

  /**
   * Approve a pairing on behalf of an authenticated user.
   *
   * `owner` MUST come from the approving user's own session. A daemon can
   * never assert who it is — that is the whole reason pairing is interactive
   * ({@link MUSTS.PAIR_ONE_USER}, {@link MUSTS.PAIR_INTERACTIVE}).
   */
  async approvePairing(args: {
    userCode: string;
    owner: string;
  }): Promise<RunnerRecord> {
    const token = generateRunnerToken();
    return this.#store.approvePairing({
      userCode: normalizeUserCode(args.userCode),
      owner: args.owner,
      runnerId: generateRunnerId(),
      runnerToken: token,
      tokenHash: hashSecret(token),
      now: this.#now(),
    });
  }

  /** Deny a pairing the user did not initiate. */
  async denyPairing(userCode: string): Promise<void> {
    return this.#store.denyPairing(normalizeUserCode(userCode), this.#now());
  }

  /** What a pairing code refers to, for the approval page to show. */
  async pendingPairing(userCode: string): Promise<{
    label: string;
    platform: string;
    daemonVersion: string;
    capabilities: readonly { kind: string; model: string }[];
    expiresAt: number;
  } | null> {
    const pairing = await this.#store.getPairingByUserCode(
      normalizeUserCode(userCode),
    );
    if (pairing?.state !== "pending") return null;
    if (pairing.expiresAt <= this.#now()) return null;
    return {
      label: pairing.label,
      platform: pairing.platform,
      daemonVersion: pairing.daemonVersion,
      capabilities: pairing.capabilities.map((c) => ({
        kind: c.kind,
        model: c.model,
      })),
      expiresAt: pairing.expiresAt,
    };
  }

  /** The user's paired runners, for a settings page. */
  async runners(owner: string): Promise<RunnerRecord[]> {
    return this.#store.listRunners(owner);
  }

  /** Revoke a runner. It stops at its next heartbeat, mid-queue. */
  async revokeRunner(runnerId: string): Promise<void> {
    return this.#store.revokeRunner(runnerId, this.#now());
  }

  /** Run the expiry sweep. Idempotent; safe to call on a timer or a request. */
  async sweep(): Promise<JobRecord[]> {
    return this.#store.expireDue(this.#now());
  }
}

/**
 * Accept a pairing code however the user typed it — lowercase, spaces, no
 * dash. The code is displayed as `XXXX-XXXX`; refusing `xxxxxxxx` would fail
 * a user for a formatting detail they were never told mattered.
 */
export function normalizeUserCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}
