import type { DeliveredResult } from "@byollm/protocol";

/** Why a wait ended without a result. */
export class NoRunnerAvailableError extends Error {
  override readonly name = "NoRunnerAvailableError";
  constructor(
    readonly jobId: string,
    readonly reason: string,
  ) {
    super(
      `no runner is available to execute job ${jobId} (${reason}). ` +
        `Fall back to a hosted model, or prompt the user to start their runner.`,
    );
  }
}

/** The wait exceeded its timeout while a runner was still plausibly working. */
export class ResultTimeoutError extends Error {
  override readonly name = "ResultTimeoutError";
  constructor(
    readonly jobId: string,
    readonly timeoutMs: number,
  ) {
    super(`job ${jobId} did not finish within ${String(timeoutMs)}ms`);
  }
}

export interface WaitOptions {
  /** Give up after this long. Default 5 minutes. */
  readonly timeoutMs?: number;
  /**
   * Called instead of throwing when no runner can take the job. Return a
   * substitute result (a hosted-model answer, say) and the wait resolves with
   * it; return nothing and {@link NoRunnerAvailableError} is thrown.
   */
  readonly onNoRunner?: (
    reason: string,
  ) => DeliveredResult | undefined | Promise<DeliveredResult | undefined>;
  /** Abort the wait. */
  readonly signal?: AbortSignal;
}

/**
 * How an app learns a job finished.
 *
 * byollm_003 Rev 1 is explicit that this is a *channel* — webhook, Realtime
 * subscription, or poll — and never an implied in-request `await`. The
 * polling implementation below is the portable default; the Supabase adapter
 * substitutes Realtime for the same interface.
 */
export interface ResultDelivery {
  waitFor(jobId: string, options?: WaitOptions): Promise<DeliveredResult>;
}

export interface PollingDeliveryDeps {
  /** Current state of the job, or null if unknown. */
  readonly read: (jobId: string) => Promise<DeliveredResult | null>;
  /** Whether a runner could still take this job. */
  readonly availability: (
    jobId: string,
  ) => Promise<{ available: boolean; reason?: string; blocked: boolean }>;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable clock. It must advance in step with {@link sleep}: a test that
   * stubs one and not the other gets a loop whose grace window never elapses.
   */
  readonly now?: () => number;
  /**
   * How long a sustained no-runner signal must persist before it is believed.
   * Defaults to {@link NO_RUNNER_GRACE_MS}.
   */
  readonly graceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 500;
/**
 * How long to let a job sit with no available runner before giving up.
 *
 * Not zero: a daemon restarting, or one whose heartbeat is momentarily late,
 * would otherwise fail every job in flight. The signal has to be sustained
 * before it is believed.
 */
const NO_RUNNER_GRACE_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The portable delivery channel: poll the store until the job is terminal.
 *
 * Correct everywhere and adequate for most apps. An adapter with a push
 * channel should replace it — see the Supabase adapter's Realtime delivery.
 */
export class PollingDelivery implements ResultDelivery {
  readonly #deps: PollingDeliveryDeps;

  constructor(deps: PollingDeliveryDeps) {
    this.#deps = deps;
  }

  async waitFor(
    jobId: string,
    options: WaitOptions = {},
  ): Promise<DeliveredResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sleep = this.#deps.sleep ?? defaultSleep;
    const now = this.#deps.now ?? Date.now;
    const graceMs = this.#deps.graceMs ?? NO_RUNNER_GRACE_MS;
    const started = now();
    let noRunnerSince: number | null = null;

    for (;;) {
      options.signal?.throwIfAborted();

      const current = await this.#deps.read(jobId);
      if (current && isTerminalState(current.state)) return current;

      const availability = await this.#deps.availability(jobId);
      if (availability.available || availability.blocked) {
        // `blocked` means the job is waiting on a dependency, which is not the
        // same event as "nobody can run this" ({@link MUSTS.NO_RUNNER_SIGNAL}).
        noRunnerSince = null;
      } else {
        noRunnerSince ??= now();
        if (now() - noRunnerSince >= graceMs) {
          const reason = availability.reason ?? "no-runner-online";
          const substitute = await options.onNoRunner?.(reason);
          if (substitute) return substitute;
          throw new NoRunnerAvailableError(jobId, reason);
        }
      }

      if (now() - started >= timeoutMs) {
        throw new ResultTimeoutError(jobId, timeoutMs);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function isTerminalState(state: string): boolean {
  return (
    state === "ok" ||
    state === "error" ||
    state === "canceled" ||
    state === "expired"
  );
}
