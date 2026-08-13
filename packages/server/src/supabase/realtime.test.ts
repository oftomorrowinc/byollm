import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PollingDeliveryDeps } from "../delivery.js";
import { supabaseRealtimeDelivery } from "./realtime.js";

/**
 * The Realtime channel had three promises discarded with `void`, and every one
 * of them turned an ordinary failure into a dead process: an unhandled
 * rejection ends Node.
 *
 * It had no unit test at all — it was covered only by the Supabase conformance
 * job, which runs the happy path against real Postgres and therefore never
 * made any of them reject. That is how all three survived review. These tests
 * exist to make the failure paths the tested ones.
 *
 * The contract each asserts: **a failure reaches the caller who is awaiting
 * `result()`.** The polling channel gets that for free by running inside the
 * awaited chain; this one has to route it deliberately. A delivery adapter
 * must not change what a failure means.
 */

/** The smallest client the channel actually uses. */
function fakeClient(): SupabaseClient {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return {
    channel: () => channel,
    removeChannel: () => Promise.resolve("ok"),
  } as unknown as SupabaseClient;
}

function deliveryWith(deps: Partial<PollingDeliveryDeps>) {
  const full: PollingDeliveryDeps = {
    read: () => Promise.resolve(null),
    availability: () => Promise.resolve({ available: true, blocked: false }),
    ...deps,
  };
  return supabaseRealtimeDelivery(fakeClient())(full);
}

/** Nothing may reach the process-level handler; that is the whole point. */
let unhandled: unknown[];
const record = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", record);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.off("unhandledRejection", record);
});

/** Run past the no-runner grace window and the watcher's 2s tick. */
async function tickPastGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(13_000);
}

describe("a failure reaches the awaiting caller, not the process", () => {
  it("rejects when the caller's own onNoRunner throws", async () => {
    // An app whose fallback calls a hosted model and gets a 500. That is an
    // app bug; it should surface at the app's `await`, not kill the server.
    const delivery = deliveryWith({
      availability: () =>
        Promise.resolve({
          available: false,
          blocked: false,
          reason: "no-runner-online",
        }),
    });

    const waiting = delivery.waitFor("job_1", {
      onNoRunner: () => {
        throw new Error("hosted fallback exploded");
      },
    });
    const settled = expect(waiting).rejects.toThrow("hosted fallback exploded");
    await tickPastGrace();
    await settled;
    expect(unhandled).toEqual([]);
  });

  it("rejects when the availability check itself fails", async () => {
    // Needs no app bug at all: a transient store error was enough to end the
    // process. This is the half the original report did not mention.
    const delivery = deliveryWith({
      availability: () => Promise.reject(new Error("store unreachable")),
    });

    const waiting = delivery.waitFor("job_2", {});
    const settled = expect(waiting).rejects.toThrow("store unreachable");
    await tickPastGrace();
    await settled;
    expect(unhandled).toEqual([]);
  });

  it("rejects when the post-subscribe read fails", async () => {
    // `#check` runs once immediately after subscribing, outside any await.
    const delivery = deliveryWith({
      read: vi
        .fn<PollingDeliveryDeps["read"]>()
        // The first read happens before the channel exists and is awaited
        // normally; the second is the fire-and-forget one that used `void`.
        .mockResolvedValueOnce(null)
        .mockRejectedValue(new Error("read failed")),
    });

    const waiting = delivery.waitFor("job_3", {});
    const settled = expect(waiting).rejects.toThrow("read failed");
    await vi.advanceTimersByTimeAsync(10);
    await settled;
    expect(unhandled).toEqual([]);
  });

  it("still delivers a substitute when onNoRunner supplies one", async () => {
    // The fix must not turn a working fallback into a rejection.
    const delivery = deliveryWith({
      availability: () =>
        Promise.resolve({
          available: false,
          blocked: false,
          reason: "no-runner-online",
        }),
    });

    const waiting = delivery.waitFor("job_4", {
      onNoRunner: () => ({
        jobId: "job_4",
        state: "ok" as const,
        outcome: { outcome: "ok" as const, text: "from the hosted model" },
      }),
    });
    await tickPastGrace();
    await expect(waiting).resolves.toMatchObject({ state: "ok" });
    expect(unhandled).toEqual([]);
  });
});
