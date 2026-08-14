import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";
import { createHarness, httpCapabilities } from "./testing.js";

/**
 * The store paths a happy run never takes: results for jobs nobody holds,
 * releases of things not held, sweeps with nothing to sweep.
 */
describe("MemoryStore — edges", () => {
  const now = 1_700_000_000_000;

  it("returns null for a job that was never created", async () => {
    expect(await new MemoryStore().get("job_nope")).toBeNull();
  });

  it("refuses a result for a job that does not exist", async () => {
    const store = new MemoryStore();
    const result = await store.complete({
      jobId: "job_nope",
      runnerId: "r",
      outcome: { outcome: "ok", text: "x" },
      provenance: {
        audience: "self",
        runnerId: "r",
        runnerOwner: "me",
        backendClass: "http",
        model: "m",
        untrusted: false,
      },
      now,
    });
    expect(result).toEqual({ accepted: false, job: null });
  });

  it("refuses a result for an expired job", async () => {
    const store = new MemoryStore({ defaultTtlMs: 10 });
    const job = await store.create(
      { kind: "llm.generate", payload: { prompt: "x" }, owner: "me" },
      now,
    );
    await store.expireDue(now + 1_000);

    const result = await store.complete({
      jobId: job.id,
      runnerId: "r",
      outcome: { outcome: "ok", text: "too late" },
      provenance: {
        audience: "self",
        runnerId: "r",
        runnerOwner: "me",
        backendClass: "http",
        model: "m",
        untrusted: false,
      },
      now: now + 1_000,
    });
    expect(result.accepted).toBe(false);
    expect(result.job?.state).toBe("expired");
  });

  it("ignores a release of jobs this runner never held", async () => {
    const store = new MemoryStore();
    expect(
      await store.release({
        runnerId: "r",
        jobIds: ["job_nope"],
        reason: "shutdown",
        now,
      }),
    ).toEqual([]);
  });

  it("reports nothing for renewals with no job ids", async () => {
    const store = new MemoryStore();
    expect(
      await store.renewLeases({ runnerId: "r", jobIds: [], leaseMs: 1, now }),
    ).toEqual({ renewed: [], lost: [] });
  });

  it("returns nothing for a runner that does not exist", async () => {
    const store = new MemoryStore();
    expect(await store.getRunner("runner_nope")).toBeNull();
    expect(await store.getRunnerByTokenHash("nope")).toBeNull();
    expect(await store.getPairingByUserCode("ZZZZ-ZZZZ")).toBeNull();
    expect(await store.getPairingByDeviceCodeHash("nope")).toBeNull();
    expect(
      await store.touchRunner({
        runnerId: "runner_nope",
        capabilities: [],
        daemonVersion: "0",
        paused: false,
        now,
      }),
    ).toBeNull();
  });

  it("is a no-op when revoking or consuming something that is not there", async () => {
    const store = new MemoryStore();
    await expect(
      store.revokeRunner("runner_nope", now),
    ).resolves.toBeUndefined();
    await expect(store.consumePairingToken("nope")).resolves.toBeUndefined();
    await expect(store.denyPairing("ZZZZ-ZZZZ", now)).resolves.toBeUndefined();
  });

  it("lists every runner when no owner is given", async () => {
    const h = createHarness();
    await h.pair({ owner: "alice" });
    await h.pair({ owner: "bob" });
    expect(await h.store.listRunners()).toHaveLength(2);
    expect(await h.store.listRunners("alice")).toHaveLength(1);
  });

  it("leaves a terminal job alone when cancelled", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await h.call(
      "claim",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner,
    );
    await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: handle.id,
        outcome: { outcome: "ok", text: "done" },
        model: "m",
        backendClass: "http",
        durationMs: 1,
      },
      runner,
    );

    await h.app.cancel(handle.id);
    // A finished job stays finished; cancel is not a way to rewrite history.
    expect((await h.app.job(handle.id))?.state).toBe("ok");
  });

  it("reports no cancel requests for a runner holding nothing", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    expect(await h.store.listCancelRequests(runner.runnerId)).toEqual([]);
    expect(await h.store.listClaimedBy(runner.runnerId)).toEqual([]);
  });
});

describe("handlers — malformed input", () => {
  it("rejects a pair request that is not a pair request", async () => {
    const h = createHarness();
    const response = await h.handlers.handle(
      "pair",
      { action: "nope" },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(response.status).toBe(400);
  });

  it("404s a poll for a device code nobody issued", async () => {
    const h = createHarness();
    const response = await h.handlers.handle(
      "pair",
      { protocolVersion: "0", action: "poll", deviceCode: "d".repeat(32) },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(response.status).toBe(404);
  });

  it("rejects an unsigned request as unauthorized", async () => {
    const h = createHarness();
    // No signature at all — the shape a caller who has not read the protocol
    // sends, and the shape every pre-009 daemon sends.
    const res = await h.handlers.handle(
      "claim",
      {},
      { endpoint: "claim", rawBody: "{}", signature: undefined },
    );
    expect(res.status).toBe(401);
  });
});
