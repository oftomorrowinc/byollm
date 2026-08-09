import type { DeliveredResult } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  NoRunnerAvailableError,
  PollingDelivery,
  ResultTimeoutError,
} from "./delivery.js";

/** A delivery whose clock and store are entirely under the test's control. */
function makeDelivery(script: {
  reads: (DeliveredResult | null)[];
  availability?: { available: boolean; reason?: string; blocked: boolean }[];
}) {
  let readIndex = 0;
  let availIndex = 0;
  let clock = 1_000_000;
  const slept: number[] = [];
  const delivery = new PollingDelivery({
    now: () => clock,
    read: () =>
      Promise.resolve(
        script.reads[Math.min(readIndex++, script.reads.length - 1)] ?? null,
      ),
    availability: () =>
      Promise.resolve(
        script.availability?.[
          Math.min(availIndex++, script.availability.length - 1)
        ] ?? { available: true, blocked: false },
      ),
    // No real waiting — the fake clock advances instead, so the grace window
    // and the timeout still elapse in the same proportion they would live.
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return { delivery, slept };
}

const finished: DeliveredResult = {
  jobId: "job_1",
  state: "ok",
  outcome: { outcome: "ok", text: "hello" },
};
const pending: DeliveredResult = { jobId: "job_1", state: "queued" };

describe("PollingDelivery", () => {
  it("resolves once the job reaches a terminal state", async () => {
    const { delivery } = makeDelivery({
      reads: [pending, pending, finished],
    });
    await expect(delivery.waitFor("job_1")).resolves.toEqual(finished);
  });

  it("resolves immediately for an already-finished job", async () => {
    const { delivery, slept } = makeDelivery({ reads: [finished] });
    await expect(delivery.waitFor("job_1")).resolves.toEqual(finished);
    expect(slept).toEqual([]);
  });

  it.each(["error", "canceled", "expired"] as const)(
    "treats %s as terminal too",
    async (state) => {
      const { delivery } = makeDelivery({
        reads: [{ jobId: "job_1", state }],
      });
      await expect(delivery.waitFor("job_1")).resolves.toMatchObject({ state });
    },
  );

  it("throws NoRunnerAvailable once the signal is sustained", async () => {
    const { delivery } = makeDelivery({
      reads: [pending],
      availability: [
        { available: false, reason: "no-runner-online", blocked: false },
      ],
    });
    await expect(delivery.waitFor("job_1")).rejects.toBeInstanceOf(
      NoRunnerAvailableError,
    );
  });

  it("does not give up on a momentary blip", async () => {
    // A daemon restarting must not fail every job in flight.
    const { delivery } = makeDelivery({
      reads: [pending, pending, finished],
      availability: [
        { available: false, reason: "no-runner-online", blocked: false },
        { available: true, blocked: false },
        { available: true, blocked: false },
      ],
    });
    await expect(delivery.waitFor("job_1")).resolves.toEqual(finished);
  });

  it("never reports no-runner for a job blocked on a dependency", async () => {
    // Waiting on a dependency is not the same event as "nobody can run this"
    // — conflating them makes every multi-job flow look broken.
    const { delivery } = makeDelivery({
      reads: [pending, pending, finished],
      availability: [
        { available: false, blocked: true },
        { available: false, blocked: true },
        { available: true, blocked: false },
      ],
    });
    await expect(delivery.waitFor("job_1")).resolves.toEqual(finished);
  });

  it("lets onNoRunner supply a fallback instead of throwing", async () => {
    const hosted: DeliveredResult = {
      jobId: "job_1",
      state: "ok",
      outcome: { outcome: "ok", text: "from the hosted model" },
    };
    const { delivery } = makeDelivery({
      reads: [pending],
      availability: [
        { available: false, reason: "no-runner-paired", blocked: false },
      ],
    });
    const result = await delivery.waitFor("job_1", {
      onNoRunner: (reason) => {
        expect(reason).toBe("no-runner-paired");
        return hosted;
      },
    });
    expect(result).toEqual(hosted);
  });

  it("still throws when onNoRunner declines to substitute", async () => {
    const { delivery } = makeDelivery({
      reads: [pending],
      availability: [
        { available: false, reason: "no-runner-online", blocked: false },
      ],
    });
    await expect(
      delivery.waitFor("job_1", { onNoRunner: () => undefined }),
    ).rejects.toBeInstanceOf(NoRunnerAvailableError);
  });

  it("times out rather than hanging forever", async () => {
    const { delivery } = makeDelivery({ reads: [pending] });
    await expect(
      delivery.waitFor("job_1", { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(ResultTimeoutError);
  });

  it("honours an abort signal", async () => {
    const { delivery } = makeDelivery({ reads: [pending] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      delivery.waitFor("job_1", { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("says something actionable in the no-runner error", () => {
    const error = new NoRunnerAvailableError("job_1", "no-runner-online");
    expect(error.message).toContain("hosted model");
    expect(error.message).toContain("start their runner");
  });
});
