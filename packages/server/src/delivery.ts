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
   * substitute and the wait resolves with it; return nothing and
   * {@link NoRunnerAvailableError} is thrown.
   *
   * **A string is enough.** It is the app's own fallback answer — a hosted
   * model's text, a cached reply — not wire data, and requiring a whole
   * `DeliveredResult` for it was ceremony that invited invented shapes. The
   * README's own example got it wrong, which is how this was found.
   *
   * **Whatever comes back is labelled `fallback: true` by the wait, not by
   * the caller** — {@link MUSTS.FALLBACK_LABELED}. Work that did not come
   * from the user's own compute must not be reportable as though it did, and
   * that stays true whether an app returns a bare string or a full record it
   * assembled itself. The stamp is applied after this function returns, so
   * there is no shape an app can hand back that hides what it is.
   */
  readonly onNoRunner?: (
    reason: string,
  ) =>
    | string
    | DeliveredResult
    | undefined
    | Promise<string | DeliveredResult | undefined>;
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
  /**
   * Whether a runner could still take this job — **when there is anybody to
   * ask.**
   *
   * Optional since alpha.66, and its absence is the answer rather than a
   * missing dependency. On the cloud lane nothing writes runners into this
   * site's store: devices pair with the relay, so the question has no local
   * answer and `runnerAvailability` refuses to invent one.
   *
   * The refusal was correct and it landed in a loop that asked every 500ms.
   * `job.result()` threw on its first poll for every cloud-lane site — a
   * refusal aimed at outsiders that our own delivery tripped over.
   *
   * Not fixed by catching the throw here. That is a swallowed error in
   * costume, and a catch wide enough to hold it would also eat a store that
   * had genuinely gone away. The instrument is simply not handed over on a
   * lane where it cannot see, and this loop does not ask a question nobody
   * can answer.
   */
  readonly availability?: (
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

      /**
       * The no-runner signal, when this deployment has one.
       *
       * With no instrument there is no sustained-absence signal and no
       * `NoRunnerAvailableError` — the wait ends when the job reaches a
       * terminal state or the timeout does. That is the honest behaviour on
       * the cloud lane, where an unsatisfiable slot is refused at enqueue and
       * a job with nowhere to run expires, both of which arrive through
       * `read` as states rather than as guesses made here.
       */
      const availability = await this.#deps.availability?.(jobId);
      if (
        availability === undefined ||
        availability.available ||
        availability.blocked
      ) {
        // `blocked` means the job is waiting on a dependency, which is not the
        // same event as "nobody can run this" ({@link MUSTS.NO_RUNNER_SIGNAL}).
        noRunnerSince = null;
      } else {
        noRunnerSince ??= now();
        if (now() - noRunnerSince >= graceMs) {
          const reason = availability.reason ?? "no-runner-online";
          const substitute = await options.onNoRunner?.(reason);
          if (substitute !== undefined) {
            return labelFallback(jobId, substitute);
          }
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

/**
 * Turn an app's fallback into a delivered result, marked as one.
 *
 * Exported because there are two delivery channels — polling here, Supabase
 * Realtime next door — and a label applied by one of them is a label an app
 * gets or does not get depending on which store it chose. That is exactly the
 * kind of divergence a "delivery adapter must not change what a result means"
 * rule exists to prevent.
 *
 * Two jobs, and the second is the one that matters. A string becomes the
 * obvious record — that is the sugar. Everything, string or record, gets
 * `fallback: true` — that is {@link MUSTS.FALLBACK_LABELED}, and it is
 * applied here rather than trusted from the caller because an app that
 * assembled its own record could otherwise return something indistinguishable
 * from a runner's answer. Spreading the caller's object first and the flag
 * second is deliberate: a supplied `fallback` cannot overwrite it.
 */
export function labelFallback(
  jobId: string,
  substitute: string | DeliveredResult,
): DeliveredResult {
  if (typeof substitute === "string") {
    return {
      jobId,
      state: "ok",
      outcome: { outcome: "ok", text: substitute },
      fallback: true,
    };
  }
  return { ...substitute, fallback: true };
}
