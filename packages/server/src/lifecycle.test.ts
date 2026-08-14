import { describe, expect, it } from "vitest";
import {
  createHarness,
  httpCapabilities,
  type PairedRunner,
} from "./testing.js";

const generate = (owner = "alice") =>
  ({ kind: "llm.generate", payload: { prompt: "hi" }, owner }) as const;

async function claimAll(
  h: ReturnType<typeof createHarness>,
  runner: PairedRunner,
  capabilities = httpCapabilities(),
) {
  const res = await h.call(
    "claim",
    {
      protocolVersion: "0",
      runnerId: runner.runnerId,
      capabilities,
      max: 8,
    },
    runner,
  );
  return (res.body as { jobs: { id: string }[] }).jobs;
}

async function finish(
  h: ReturnType<typeof createHarness>,
  runner: PairedRunner,
  jobId: string,
  text = "done",
) {
  return h.call(
    "result",
    {
      protocolVersion: "0",
      runnerId: runner.runnerId,
      jobId,
      outcome: { outcome: "ok", text },
      model: "gemma4:26b",
      backendClass: "http",
      durationMs: 5,
    },
    runner,
  );
}

describe("lease reclaim [LEASE_RECLAIMABLE]", () => {
  it("loses nothing when a daemon is killed mid-job", async () => {
    const h = createHarness({ leaseMs: 30_000 });
    const dead = await h.pair({ owner: "alice", label: "dead" });
    const handle = await h.app.enqueue(generate());

    expect(await claimAll(h, dead)).toHaveLength(1);

    // kill -9: no release, no heartbeat, the lease simply lapses.
    h.clock.advance(31_000);

    const alive = await h.pair({ owner: "alice", label: "alive" });
    const reclaimed = await claimAll(h, alive);
    expect(reclaimed.map((j) => j.id)).toEqual([handle.id]);

    await finish(h, alive, handle.id);
    expect((await h.app.result(handle.id))?.state).toBe("ok");
  });

  it("counts attempts across reclaims", async () => {
    const h = createHarness({ leaseMs: 10_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue(generate());

    await claimAll(h, runner);
    h.clock.advance(11_000);
    await claimAll(h, runner);

    expect((await h.app.job(handle.id))?.attempts).toBe(2);
  });
});

describe("TTL [TTL_EXPIRY]", () => {
  it("expires a job nobody claimed", async () => {
    const h = createHarness({ defaultTtlMs: 60_000 });
    const handle = await h.app.enqueue(generate());

    h.clock.advance(61_000);
    await h.app.sweep();

    expect((await h.app.job(handle.id))?.state).toBe("expired");
  });

  it("does not expire a job that is being worked on", async () => {
    const h = createHarness({ defaultTtlMs: 60_000, leaseMs: 300_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue(generate());
    await claimAll(h, runner);

    h.clock.advance(120_000);
    await h.app.sweep();

    expect((await h.app.job(handle.id))?.state).toBe("claimed");
  });

  it("honours an absolute deadline independently of the TTL", async () => {
    const h = createHarness({ defaultTtlMs: 10 * 60_000 });
    const handle = await h.app.enqueue({
      ...generate(),
      deadlineAt: 1_700_000_000_000 + 5_000,
    });

    h.clock.advance(6_000);
    await h.app.sweep();

    expect((await h.app.job(handle.id))?.state).toBe("expired");
  });

  it("is idempotent — sweeping twice changes nothing the second time", async () => {
    const h = createHarness({ defaultTtlMs: 1_000 });
    await h.app.enqueue(generate());
    h.clock.advance(2_000);

    expect(await h.app.sweep()).toHaveLength(1);
    expect(await h.app.sweep()).toHaveLength(0);
  });
});

describe("dependencies [DEPENDS_ON_GATING]", () => {
  it("withholds a dependent job until its dependency is ok", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const first = await h.app.enqueue(generate());
    const second = await h.app.enqueue({
      ...generate(),
      dependsOn: [first.id],
    });

    const claimed = await claimAll(h, runner);
    expect(claimed.map((j) => j.id)).toEqual([first.id]);

    await finish(h, runner, first.id);

    const next = await claimAll(h, runner);
    expect(next.map((j) => j.id)).toEqual([second.id]);
  });

  it("starts the dependent job's TTL clock when it becomes claimable, not at enqueue", async () => {
    // The bug this guards against: a dependent job expiring for the crime of
    // waiting on a slow dependency. The dependency here holds a long lease so
    // the only clock under test is the dependent's.
    const h = createHarness({
      defaultTtlMs: 10 * 60_000,
      leaseMs: 10 * 60_000,
    });
    const runner = await h.pair();
    const first = await h.app.enqueue(generate());
    const second = await h.app.enqueue({
      ...generate(),
      dependsOn: [first.id],
      ttlMs: 60_000,
    });

    await claimAll(h, runner);

    // The dependency takes five minutes — far past the dependent's 60s TTL.
    h.clock.advance(5 * 60_000);
    await h.app.sweep();
    expect((await h.app.job(second.id))?.state).toBe("queued");

    await finish(h, runner, first.id);

    // Only now does the dependent's clock start.
    const job = await h.app.job(second.id);
    expect(job?.claimableAt).toBe(h.clock.now());
    expect(await claimAll(h, runner)).toHaveLength(1);
  });

  it("leaves dependents blocked when a dependency fails", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const first = await h.app.enqueue(generate());
    const second = await h.app.enqueue({
      ...generate(),
      dependsOn: [first.id],
    });
    await claimAll(h, runner);

    await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: first.id,
        outcome: {
          outcome: "error",
          code: "backend-error",
          message: "model refused",
          retryable: false,
        },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 5,
      },
      runner,
    );

    // A chain stops where it broke rather than running a step whose input
    // never arrived.
    expect(await claimAll(h, runner)).toHaveLength(0);
    expect((await h.app.job(second.id))?.claimableAt).toBeNull();
  });

  it("waits for every dependency, not just one", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const a = await h.app.enqueue(generate());
    const b = await h.app.enqueue(generate());
    const c = await h.app.enqueue({ ...generate(), dependsOn: [a.id, b.id] });

    await claimAll(h, runner);
    await finish(h, runner, a.id);
    expect((await h.app.job(c.id))?.claimableAt).toBeNull();

    await finish(h, runner, b.id);
    expect((await h.app.job(c.id))?.claimableAt).not.toBeNull();
  });
});

describe("cancel", () => {
  it("cancels a queued job outright", async () => {
    const h = createHarness();
    const handle = await h.app.enqueue(generate());
    await h.app.cancel(handle.id);
    expect((await h.app.job(handle.id))?.state).toBe("canceled");
  });

  it("leaves a held job running until its runner acknowledges", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue(generate());
    await claimAll(h, runner);

    await h.app.cancel(handle.id);
    expect((await h.app.job(handle.id))?.state).toBe("claimed");

    await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: handle.id,
        outcome: { outcome: "canceled" },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 5,
      },
      runner,
    );
    expect((await h.app.job(handle.id))?.state).toBe("canceled");
  });

  it("returns null for a job that does not exist", async () => {
    const h = createHarness();
    expect(await h.app.cancel("job_nope")).toBeNull();
  });
});

describe("idempotent enqueue", () => {
  it("treats a repeated caller-supplied id as the same job", async () => {
    const h = createHarness();
    const first = await h.app.enqueue({ ...generate(), id: "job_fixed" });
    const second = await h.app.enqueue({ ...generate(), id: "job_fixed" });
    expect(second.id).toBe(first.id);
    expect(h.store.allJobs()).toHaveLength(1);
  });
});

describe("no-runner signal [NO_RUNNER_SIGNAL]", () => {
  it("reports no runner paired at all", async () => {
    const h = createHarness();
    const availability = await h.app.runnerAvailability({
      kind: "llm.generate",
      owner: "alice",
    });
    expect(availability).toMatchObject({
      available: false,
      reason: "no-runner-paired",
    });
  });

  it("reports a paired runner that has gone quiet", async () => {
    const h = createHarness();
    await h.pair({ owner: "alice" });
    h.clock.advance(60_000);

    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: false, reason: "no-runner-online" });
  });

  it("reports a live runner that lacks the capability", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: [httpCapabilities()[0]!],
        activeJobIds: [],
        paused: false,
      },
      runner,
    );

    expect(
      await h.app.runnerAvailability({ kind: "llm.chat", owner: "alice" }),
    ).toMatchObject({ available: false, reason: "no-matching-capability" });
  });

  it("reports a live capable runner the audience excludes", async () => {
    const h = createHarness();
    await h.pair({ owner: "bob" });
    expect(
      await h.app.runnerAvailability({
        kind: "llm.generate",
        owner: "alice",
        audience: "self",
      }),
    ).toMatchObject({ available: false, reason: "audience-admits-nobody" });
  });

  it("reports available for a live, capable, admitted runner", async () => {
    const h = createHarness();
    await h.pair({ owner: "alice" });
    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: true, candidates: 1 });
  });

  it("treats a paused runner as offline", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeJobIds: [],
        paused: true,
      },
      runner,
    );
    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: false, reason: "no-runner-online" });
  });
});
