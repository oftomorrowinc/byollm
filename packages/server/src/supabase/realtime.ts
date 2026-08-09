import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveredResult } from "@byollm/protocol";
import {
  NoRunnerAvailableError,
  ResultTimeoutError,
  type PollingDeliveryDeps,
  type ResultDelivery,
  type WaitOptions,
} from "../delivery.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/**
 * How long a sustained no-runner signal must persist before it is believed.
 * A daemon restarting must not fail every job in flight.
 */
const NO_RUNNER_GRACE_MS = 10_000;

/**
 * Realtime delivery: the app learns a job finished when Postgres says so.
 *
 * byollm_003 Rev 1 requires the server→app path be an explicit channel rather
 * than an implied in-request `await`. Polling is the portable default;
 * this is the one worth having when the app is already on Supabase, because
 * a result arrives in milliseconds instead of on the next poll tick.
 *
 * The no-runner watch still polls, deliberately: runner liveness is a
 * *derived* signal (nobody with matching capability has heartbeated lately),
 * and there is no row change to subscribe to for "something stopped
 * happening".
 */
export function supabaseRealtimeDelivery(
  client: SupabaseClient,
): (deps: PollingDeliveryDeps) => ResultDelivery {
  return (deps) => new SupabaseRealtimeDelivery(client, deps);
}

class SupabaseRealtimeDelivery implements ResultDelivery {
  readonly #client: SupabaseClient;
  readonly #deps: PollingDeliveryDeps;

  constructor(client: SupabaseClient, deps: PollingDeliveryDeps) {
    this.#client = client;
    this.#deps = deps;
  }

  async waitFor(
    jobId: string,
    options: WaitOptions = {},
  ): Promise<DeliveredResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Read first. The job may already be terminal, and subscribing to a
    // channel for an event that has already happened waits forever.
    const current = await this.#deps.read(jobId);
    if (current && isTerminal(current.state)) return current;

    const channel = this.#client.channel(`byollm_job_${jobId}`).on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "byollm_jobs",
        filter: `id=eq.${jobId}`,
      },
      () => {
        void this.#check(jobId);
      },
    );

    const settled = Promise.withResolvers<DeliveredResult>();
    this.#resolve = settled.resolve;

    // `subscribe()` returns the channel, not a promise — awaiting it would be
    // a no-op that reads as if it waited for the subscription to be live.
    channel.subscribe();

    // A second read after subscribing closes the race where the job finished
    // between the first read and the subscription taking effect.
    void this.#check(jobId);

    const timer = setTimeout(() => {
      settled.reject(new ResultTimeoutError(jobId, timeoutMs));
    }, timeoutMs);

    const watcher = this.#watchAvailability(jobId, options, settled);
    const abort = (): void => {
      settled.reject(new Error("wait aborted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      return await settled.promise;
    } finally {
      clearTimeout(timer);
      clearInterval(watcher);
      options.signal?.removeEventListener("abort", abort);
      await this.#client.removeChannel(channel);
    }
  }

  #resolve: ((result: DeliveredResult) => void) | undefined;

  async #check(jobId: string): Promise<void> {
    const current = await this.#deps.read(jobId);
    if (current && isTerminal(current.state)) this.#resolve?.(current);
  }

  /** Poll runner liveness; there is no row event for "nothing is happening". */
  #watchAvailability(
    jobId: string,
    options: WaitOptions,
    settled: PromiseWithResolvers<DeliveredResult>,
  ): NodeJS.Timeout {
    let noRunnerSince: number | null = null;

    return setInterval(() => {
      void (async () => {
        const availability = await this.#deps.availability(jobId);
        if (availability.available || availability.blocked) {
          noRunnerSince = null;
          return;
        }
        noRunnerSince ??= Date.now();
        if (Date.now() - noRunnerSince < NO_RUNNER_GRACE_MS) return;

        const reason = availability.reason ?? "no-runner-online";
        const substitute = await options.onNoRunner?.(reason);
        if (substitute) {
          settled.resolve(substitute);
        } else {
          settled.reject(new NoRunnerAvailableError(jobId, reason));
        }
      })();
    }, 2_000);
  }
}

function isTerminal(state: string): boolean {
  return (
    state === "ok" ||
    state === "error" ||
    state === "canceled" ||
    state === "expired"
  );
}
