import type { Capability } from "@byollm/protocol";
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
    await h.resultBody({
      jobId,
      runner,
      outcome: { outcome: "ok", text },
      model: "gemma4:26b",
    }),
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
      await h.resultBody({
        jobId: first.id,
        runner: runner,
        outcome: {
          outcome: "error",
          code: "backend-error",
          message: "model refused",
          retryable: false,
        },
        model: "gemma4:26b",
        backendClass: "http",
      }),
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
      await h.resultBody({
        jobId: handle.id,
        runner: runner,
        outcome: { outcome: "canceled" },
        model: "gemma4:26b",
        backendClass: "http",
      }),
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
        activeLeases: [],
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
        audience: "private",
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
        activeLeases: [],
        paused: true,
      },
      runner,
    );
    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: false, reason: "no-runner-online" });
  });
});

describe("selection and defaults, at enqueue time [byollm_016 Phase B]", () => {
  /**
   * Each of these sends the reader somewhere different — fix a typo, choose a
   * default, install something, or ask the device's owner to change theirs.
   * Collapsing them would send everybody to the last, which is the failure
   * `NO_RUNNER_SIGNAL` exists to prevent: an app that cannot tell "not yet"
   * from "never" makes both look like a hang.
   *
   * Distinguishing them is safe *here* and nowhere else. This answers a site
   * about its own users' devices, whose capabilities it already stores. The
   * same split on the wire would let a stranger probe service names to
   * enumerate somebody else's machine, which is exactly why `RefusalReason`
   * collapses two of them into one opaque value.
   */
  const beat = async (
    h: ReturnType<typeof createHarness>,
    runner: PairedRunner,
    capabilities: Capability[],
  ) =>
    h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities,
        activeLeases: [],
        paused: false,
      },
      runner,
    );

  const cap = (
    service: string,
    isDefault: boolean,
    offerScope: Capability["offerScope"] = "private",
  ): Capability => ({
    kind: "llm.generate",
    service,
    isDefault,
    backendId: "openai-http",
    backendClass: "http",
    model: "qwen",
    offerScope,
  });

  it("says a named service cannot serve them, without saying why", async () => {
    // The kind is served; that name is not. The reader learns their selection
    // will not run — enough to fix a typo or ask the device's owner — and
    // learns nothing about what that owner actually has.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", true)]);

    expect(
      await h.app.runnerAvailability({
        kind: "llm.generate",
        owner: "alice",
        service: "typo",
      }),
    ).toMatchObject({ available: false, reason: "selection-unavailable" });
  });

  it("answers identically whether the name is unknown or merely not offered", async () => {
    // Constraint one of the terminal ruling, as arithmetic. These are
    // different facts and must be one answer: if they differ, a requester
    // tries names, sorts the replies, and enumerates a device they were never
    // offered — the collapse in `RefusalReason` defeated by a helpful SDK
    // relaying the finer reason it was given.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", true, "private")]);

    const unknown = await h.app.runnerAvailability({
      kind: "llm.generate",
      owner: "bob",
      audience: "team",
      service: "no-such-name",
    });
    const notOffered = await h.app.runnerAvailability({
      kind: "llm.generate",
      owner: "bob",
      audience: "team",
      service: "studio",
    });
    expect(unknown).toEqual(notOffered);
  });

  it("says a kind is waiting on a default rather than missing", async () => {
    // Two services answer it and neither is the default, which is the state
    // byollm_016 withholds. Nothing is missing; a decision is outstanding.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", false), cap("laptop", false)]);

    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: false, reason: "awaiting-default" });
  });

  it("sends an unselected job to the default, not to whatever answers", async () => {
    // The control on the two above. A device advertising a menu *and* a
    // default is available — and reporting otherwise would make the common
    // case look broken.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", true), cap("laptop", false)]);

    expect(
      await h.app.runnerAvailability({ kind: "llm.generate", owner: "alice" }),
    ).toMatchObject({ available: true });
  });

  it("names the defaults-meet-audiences corner when it bites", async () => {
    // The specimen byollm_016 called out: a default this requester can never
    // use. Reported at enqueue rather than left to expire, because a wait that
    // can never end looks exactly like one that has not ended yet.
    //
    // `bob` asking about `alice`'s device, whose default is offered to nobody
    // but its owner.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", true, "private")]);

    expect(
      await h.app.runnerAvailability({
        kind: "llm.generate",
        owner: "bob",
        audience: "team",
      }),
    ).toMatchObject({ available: false, reason: "default-unusable" });
  });

  it("keeps the kind-level reasons distinct, because they cannot be probed", async () => {
    // Not everything collapses, and the line is whether a requester can walk a
    // namespace. A service name is unbounded and supplied by the asker; a job
    // kind is neither, and `awaiting-default` is already what a roster member
    // sees on the devices page. Collapsing these would cost an app a real
    // difference — the owner can fix "has not chosen", nobody can fix "cannot
    // serve you" — and buy nothing.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await beat(h, runner, [cap("studio", false), cap("laptop", false)]);
    const waiting = await h.app.runnerAvailability({
      kind: "llm.generate",
      owner: "alice",
    });

    const h2 = createHarness();
    const runner2 = await h2.pair({ owner: "alice" });
    await beat(h2, runner2, [cap("studio", true, "private")]);
    const unusable = await h2.app.runnerAvailability({
      kind: "llm.generate",
      owner: "bob",
      audience: "team",
    });

    expect(waiting.reason).toBe("awaiting-default");
    expect(unusable.reason).toBe("default-unusable");
  });
});
