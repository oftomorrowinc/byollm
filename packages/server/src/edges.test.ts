import { describe, expect, it } from "vitest";
import { keyId, publicIdentityOf, seal } from "@byollm/protocol";
import { generateSiteKeys } from "./keys.js";
import { MemoryStore } from "./memory.js";
import { createHarness, httpCapabilities } from "./testing.js";

/**
 * The store paths a happy run never takes: results for jobs nobody holds,
 * releases of things not held, sweeps with nothing to sweep.
 */
/** A sealed store input, as the app would produce. */
const SITE = generateSiteKeys();
async function storedInput(over: { id?: string } = {}) {
  const id = over.id ?? `job_${String(Math.floor(Date.now() % 1e9))}`;
  const senderKeyId = keyId(publicIdentityOf(SITE).identity);
  const deadlineAt = 1_700_000_000_000 + 60_000;
  return {
    id,
    kind: "llm.generate" as const,
    owner: "alice",
    deadlineAt,
    sizeClass: "small" as const,
    envelope: await seal({
      plaintext: JSON.stringify({ prompt: "hi" }),
      senderKeys: SITE,
      recipientEncryptionPublic: SITE.encryptionPublic,
      context: {
        jobId: id,
        senderKeyId,
        recipientKeyId: senderKeyId,
        deadlineAt,
        direction: "payload" as const,
      },
    }),
  };
}

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
      holder: { by: "runner", runnerId: "r" },
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
    const job = await store.create(await storedInput(), now);
    await store.expireDue(now + 1_000);

    const result = await store.complete({
      jobId: job.id,
      runnerId: "r",
      holder: { by: "runner", runnerId: "r" },
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
        leases: [{ jobId: "job_nope", leaseId: "lease_nope" }],
        reason: "shutdown",
        now,
      }),
    ).toEqual([]);
  });

  it("reports nothing for renewals with no job ids", async () => {
    const store = new MemoryStore();
    expect(
      await store.renewLeases({ runnerId: "r", leases: [], leaseMs: 1, now }),
    ).toEqual({ renewed: [], lost: [] });
  });

  it("returns nothing for a runner that does not exist", async () => {
    const store = new MemoryStore();
    expect(await store.getRunner("runner_nope")).toBeNull();
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
      await h.resultBody({
        jobId: handle.id,
        runner: runner,
        outcome: { outcome: "ok", text: "done" },
        model: "m",
        backendClass: "http",
      }),
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

describe("the push seam [byollm_009 §8.3]", () => {
  const now = 1_700_000_000_000;
  const enqueue = async (store: MemoryStore) =>
    store.create(await storedInput(), now);

  it("notifies a watcher when the job changes", async () => {
    const store = new MemoryStore();
    const job = await enqueue(store);

    let calls = 0;
    store.subscribe(job.id, () => {
      calls += 1;
    });
    await store.cancel(job.id, now);

    expect(calls).toBeGreaterThan(0);
  });

  it("notifies every watcher, not just the first", async () => {
    // Two waiters on one job is ordinary — `result()` called twice, or an app
    // and a dashboard. Keying by job id alone would serve one of them.
    const store = new MemoryStore();
    const job = await enqueue(store);
    let a = 0;
    let b = 0;
    store.subscribe(job.id, () => {
      a += 1;
    });
    store.subscribe(job.id, () => {
      b += 1;
    });

    await store.cancel(job.id, now);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("stops notifying after unsubscribe, and only that watcher", async () => {
    const store = new MemoryStore();
    const job = await enqueue(store);
    let stopped = 0;
    let kept = 0;
    const off = store.subscribe(job.id, () => {
      stopped += 1;
    });
    store.subscribe(job.id, () => {
      kept += 1;
    });

    off();
    await store.cancel(job.id, now);

    expect(stopped).toBe(0);
    expect(kept).toBeGreaterThan(0);
  });

  it("survives unsubscribing twice", async () => {
    // The contract says so, and a `finally` that runs after an error path
    // already unsubscribed is the ordinary way it happens.
    const store = new MemoryStore();
    const job = await enqueue(store);
    const off = store.subscribe(job.id, () => undefined);
    off();
    expect(() => {
      off();
    }).not.toThrow();
  });

  it("does not let a throwing watcher break the write that notified it", async () => {
    // A watcher is a signal handler. One bad listener taking out an unrelated
    // store write would be far worse than a missed notification.
    const store = new MemoryStore();
    const job = await enqueue(store);
    store.subscribe(job.id, () => {
      throw new Error("bad listener");
    });
    let reached = 0;
    store.subscribe(job.id, () => {
      reached += 1;
    });

    await expect(store.cancel(job.id, now)).resolves.toBeTruthy();
    expect(reached).toBeGreaterThan(0);
    expect((await store.get(job.id))?.state).toBe("canceled");
  });

  it("notifies on every write path, not the ones someone remembered", async () => {
    // Writes funnel through one method precisely so this holds as paths are
    // added. Claim and complete are different code from cancel.
    const store = new MemoryStore();
    const job = await enqueue(store);
    let calls = 0;
    store.subscribe(job.id, () => {
      calls += 1;
    });

    await store.claim({
      runnerId: "r",
      runnerOwner: "alice",
      capabilities: httpCapabilities(),
      max: 1,
      leaseMs: 60_000,
      now,
    });
    const afterClaim = calls;
    expect(afterClaim).toBeGreaterThan(0);

    await store.complete({
      jobId: job.id,
      runnerId: "r",
      holder: { by: "runner", runnerId: "r" },
      outcome: { outcome: "ok", text: "done" },
      provenance: {
        untrusted: false,
        audience: "self",
        runnerId: "r",
        runnerOwner: "alice",
        backendClass: "http",
        model: "echo-model",
      },
      now,
    });
    expect(calls).toBeGreaterThan(afterClaim);
  });
});
