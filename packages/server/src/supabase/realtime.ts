import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveredResult } from "@byollm/protocol";
import {
  NoRunnerAvailableError,
  ResultTimeoutError,
  type PollingDeliveryDeps,
  type ResultDelivery,
  type WaitOptions,
  labelFallback,
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

    // Declared before the subscription so the channel callback closes over a
    // `settled` that already exists. Every async path below routes its failure
    // here: a rejection that escapes this object becomes an unhandled
    // rejection, and an unhandled rejection ends the process.
    const settled = Promise.withResolvers<DeliveredResult>();
    this.#resolve = settled.resolve;

    const channel = this.#client.channel(`byollm_job_${jobId}`).on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "byollm_jobs",
        filter: `id=eq.${jobId}`,
      },
      () => {
        this.#check(jobId).catch(settled.reject);
      },
    );

    // `subscribe()` returns the channel, not a promise — awaiting it would be
    // a no-op that reads as if it waited for the subscription to be live.
    channel.subscribe();

    // A second read after subscribing closes the race where the job finished
    // between the first read and the subscription taking effect.
    this.#check(jobId).catch(settled.reject);

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
      // `.catch`, not `void`. Two things in here can reject — the store read
      // and the caller's own `onNoRunner` — and discarding either made a
      // transient store error, or an app whose fallback throws, terminate the
      // process. The caller is awaiting `result()`; that is where a failure
      // belongs, and it is what the polling channel already does by virtue of
      // running inside the awaited chain. A delivery adapter must not change
      // what a failure means.
      (async () => {
        // No instrument, no question — see `PollingDeliveryDeps`. On the
        // cloud lane `runnerAvailability` refuses rather than reporting a
        // zero it cannot see, and this timer used to reject the caller's
        // `result()` with that refusal every two seconds.
        const availability = await this.#deps.availability?.(jobId);
        if (
          availability === undefined ||
          availability.available ||
          availability.blocked
        ) {
          noRunnerSince = null;
          return;
        }
        noRunnerSince ??= Date.now();
        if (Date.now() - noRunnerSince < NO_RUNNER_GRACE_MS) return;

        const reason = availability.reason ?? "no-runner-online";
        const substitute = await options.onNoRunner?.(reason);
        if (substitute !== undefined) {
          // The same labelling the polling channel applies, from the same
          // function — {@link MUSTS.FALLBACK_LABELED} cannot depend on which
          // store an app happened to choose.
          settled.resolve(labelFallback(jobId, substitute));
        } else {
          settled.reject(new NoRunnerAvailableError(jobId, reason));
        }
      })().catch(settled.reject);
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
