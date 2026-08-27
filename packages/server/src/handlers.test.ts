import {
  PROTOCOL_VERSION,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  httpCapabilities,
  subscriptionCapabilities,
  type PairedRunner,
} from "./testing.js";

/** The (job, lease) pairs a claim response actually granted. */
const leasesFrom = (res: {
  body: unknown;
}): { jobId: string; leaseId: string }[] =>
  (res.body as { jobs: { id: string; lease: { id: string } }[] }).jobs.map(
    (j) => ({ jobId: j.id, leaseId: j.lease.id }),
  );

const claim = (runnerId: string, caps = httpCapabilities()) => ({
  protocolVersion: PROTOCOL_VERSION,
  runnerId,
  capabilities: caps,
  max: 4,
});

describe("pairing [PAIR_INTERACTIVE, PAIR_ONE_USER]", () => {
  it("issues a token only after a user approves in their own session", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    const { deviceCode, userCode } = start.body as {
      deviceCode: string;
      userCode: string;
    };

    // Before approval the daemon gets nothing, however often it polls.
    const pending = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(pending.body).toEqual({ status: "pending" });

    await h.app.approvePairing({ userCode, owner: "alice" });

    const approved = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(approved.body).toMatchObject({ status: "approved", owner: "alice" });
  });

  it("binds the pairing to exactly the approving user", async () => {
    // No token to assert on — cloud_008 §2.4 removed it. What the MUST is
    // actually about survives unchanged: the runner belongs to whoever
    // approved it, and to nobody else.
    const h = createHarness();
    const { owner } = await h.pair({ owner: "alice" });
    expect(owner).toBe("alice");
    expect(await h.app.runners("alice")).toHaveLength(1);
    expect(await h.app.runners("bob")).toHaveLength(0);
  });

  it("hands a daemon no secret at all [REQUESTS_SIGNED_NOT_BEARER]", async () => {
    // cloud_008 §2.4, finding 37. The approval used to carry `runnerToken`: a
    // secret minted here, hashed into the runner row, written to the daemon's
    // pairings file — and never sent, never looked up, never compared. Not
    // dead wire in the ordinary sense but a credential at rest with no
    // consumer, which cannot be used correctly and can still leak.
    //
    // Read positively rather than by asserting one absent field, so a secret
    // reintroduced under any name has to pass this on purpose.
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      { endpoint: "pair", rawBody: "", signature: undefined },
    );
    const { deviceCode, userCode } = start.body as {
      deviceCode: string;
      userCode: string;
    };
    await h.app.approvePairing({ userCode, owner: "alice" });

    const approved = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      { endpoint: "pair", rawBody: "", signature: undefined },
    );

    expect(Object.keys(approved.body as object).sort()).toEqual([
      "owner",
      "runnerId",
      "sites",
      "status",
    ]);
  });

  it("delivers an approval exactly once", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    const { deviceCode, userCode } = start.body as {
      deviceCode: string;
      userCode: string;
    };
    await h.app.approvePairing({ userCode, owner: "alice" });

    const first = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect((first.body as { status: string }).status).toBe("approved");

    // A replayed device code gets nothing — the token is not re-issued.
    const replay = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(replay.status).toBe(404);
  });

  it("expires an unapproved code [PAIR_CODE_EXPIRES]", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    const { deviceCode, userCode } = start.body as {
      deviceCode: string;
      userCode: string;
    };

    h.clock.advance(11 * 60_000);

    const polled = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(polled.body).toEqual({ status: "expired" });

    // And it cannot be approved late into life.
    await expect(
      h.app.approvePairing({ userCode, owner: "alice" }),
    ).rejects.toThrow(/expired/);
  });

  it("accepts a user code however the user typed it", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    const { userCode } = start.body as { userCode: string };
    const mangled = userCode.toLowerCase().replace("-", " ");
    await expect(
      h.app.approvePairing({ userCode: mangled, owner: "alice" }),
    ).resolves.toBeDefined();
  });
});

describe("authentication", () => {
  it("refuses every authenticated endpoint without a token", async () => {
    const h = createHarness();
    for (const endpoint of [
      "claim",
      "heartbeat",
      "result",
      "release",
    ] as const) {
      const res = await h.handlers.handle(
        endpoint,
        {},
        {
          endpoint: endpoint,
          rawBody: "",
          signature: undefined,
        },
      );
      expect(res.status, endpoint).toBe(401);
    }
  });

  it("refuses a runner it does not recognise", async () => {
    const h = createHarness();
    // A well-formed signature from a key nobody paired. The signature checks
    // out against itself and against nothing the server pinned, which is the
    // point: authentication is against a *stored* identity.
    const stranger = {
      token: "",
      runnerId: "runner_nobody_paired",
      owner: "nobody",
      keys: generateKeys(Date.now()),
    };
    const res = await h.call("claim", {}, stranger);
    expect(res.status).toBe(401);
  });

  it("refuses a runnerId that does not match the bearer token", async () => {
    const h = createHarness();
    const alice = await h.pair({ owner: "alice" });
    const res = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: "runner_someone-else",
        capabilities: httpCapabilities(),
        max: 1,
      },
      alice,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a body that fails schema validation", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const res = await h.call("claim", { nope: true }, runner);
    expect(res.status).toBe(400);
  });
});

describe("claim [CLAIM_REQUIRES_CAPABILITY, CLAIM_ATOMIC]", () => {
  it("hands over a matching job", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });

    const res = await h.call("claim", claim(runner.runnerId), runner);
    const body = res.body as { jobs: { id: string }[]; leaseMs: number };
    expect(body.jobs).toHaveLength(1);
    expect(body.leaseMs).toBeGreaterThan(0);
  });

  it("withholds a job whose kind is absent from this request's matrix", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.app.enqueue({
      kind: "llm.chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
      owner: "alice",
    });

    // The daemon paired advertising both kinds but now offers only generate —
    // the stored matrix must not be what the server matches on.
    const res = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: [httpCapabilities()[0]!],
        max: 4,
      },
      runner,
    );
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("never hands one job to two runners", async () => {
    const h = createHarness();
    const one = await h.pair({ owner: "alice", label: "one" });
    const two = await h.pair({ owner: "alice", label: "two" });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });

    const [a, b] = await Promise.all([
      h.call("claim", claim(one.runnerId), one),
      h.call("claim", claim(two.runnerId), two),
    ]);
    const total =
      (a.body as { jobs: unknown[] }).jobs.length +
      (b.body as { jobs: unknown[] }).jobs.length;
    expect(total).toBe(1);
  });

  it("returns an empty list — not an error — when there is no matching work", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const res = await h.call("claim", claim(runner.runnerId), runner);
    expect(res.status).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs).toEqual([]);
  });
});

describe("audience enforcement on the server [AUDIENCE_BOTH_SIDES]", () => {
  it("never gives one user's self job to another user's daemon", async () => {
    const h = createHarness();
    const bob = await h.pair({ owner: "bob" });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "alice's private prompt" },
      owner: "alice",
      audience: "private",
    });

    const res = await h.call("claim", claim(bob.runnerId), bob);
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("refuses another owner's public job on a subscription backend [SUBSCRIPTION_SELF_LOCK]", async () => {
    const h = createHarness();
    // Bob's daemon offers its subscription backend as `public` — the server
    // must ignore the widened scope, not honour it.
    const bob = await h.pair({
      owner: "bob",
      capabilities: subscriptionCapabilities("team"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "team",
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities: subscriptionCapabilities("team"),
        max: 4,
      },
      bob,
    );
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  it("offers a public job to an open backend offering public", async () => {
    const h = createHarness();
    const bob = await h.pair({
      owner: "bob",
      capabilities: httpCapabilities("team"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "team",
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("team"),
        max: 4,
      },
      bob,
    );
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("honours the server-side audienceAllow list", async () => {
    const h = createHarness();
    const bob = await h.pair({
      owner: "bob",
      capabilities: httpCapabilities("team"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "team",
      audienceAllow: ["carol"],
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("team"),
        max: 4,
      },
      bob,
    );
    expect((res.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });
});

describe("heartbeat", () => {
  it("renews leases for jobs the runner holds", async () => {
    const h = createHarness({ leaseMs: 60_000 });
    const runner = await h.pair();
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const claimed = await h.call("claim", claim(runner.runnerId), runner);
    const [held] = leasesFrom(claimed);
    const before = (await h.store.get(held!.jobId))?.lease?.expiresAt;

    h.clock.advance(30_000);
    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeLeases: leasesFrom(claimed),
        paused: false,
      },
      runner,
    );

    // Asserted against the stored grant, not against a field in the response
    // — `leases` came off the wire in §1.4b because no daemon read it, and
    // this test was reading it too. That is the better test regardless: the
    // property is that the lease was extended, and a response saying so is
    // one step removed from it. The long-job specimen in MUTATIONS.md is the
    // same lesson: renewal is a property of the grant, so check the grant.
    expect((res.body as { lost: unknown[] }).lost).toEqual([]);
    const after = (await h.store.get(held!.jobId))?.lease?.expiresAt;
    expect(after).toBe(before! + 30_000);
  });

  it("reports a job as lost once its lease was reclaimed", async () => {
    const h = createHarness({ leaseMs: 10_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const claimed = await h.call("claim", claim(runner.runnerId), runner);

    // The daemon went away for longer than its lease.
    h.clock.advance(11_000);
    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeLeases: leasesFrom(claimed),
        paused: false,
      },
      runner,
    );
    // The grant, not the id — V1-3.
    expect(
      (res.body as { lost: { jobId: string }[] }).lost.map((g) => g.jobId),
    ).toEqual([handle.id]);
    expect((res.body as { lost: { leaseId: string }[] }).lost[0]?.leaseId).toBe(
      leasesFrom(claimed)[0]?.leaseId,
    );
  });

  it("refuses a revoked runner on heartbeat too, by code [REVOCATION_HONORED]", async () => {
    // Reversed by V1-2, and the reversal is the finding.
    //
    // Heartbeat used to answer a revoked runner 200 with an empty site set,
    // and the daemon read the emptiness as revocation. But an empty set is
    // also what a half-written projection looks like — and the daemon's
    // response to revocation is to cancel everything and delete its pairings
    // file. One bad push and every machine loses the keys it pinned.
    //
    // So the fact travels as a code rather than as an absence. On heartbeat
    // specifically, because it is the only call a daemon always makes: one
    // with no working backend of its own never claims, and would otherwise
    // never find out.
    const h = createHarness();
    const runner = await h.pair();
    await h.app.revokeRunner(runner.runnerId);

    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeLeases: [],
        paused: false,
      },
      runner,
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("revoked");
  });

  it("403s a revoked runner on every other endpoint", async () => {
    const h = createHarness();
    const runner = await h.pair();
    await h.app.revokeRunner(runner.runnerId);

    const res = await h.call("claim", claim(runner.runnerId), runner);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("revoked");
  });

  it("carries a per-job cancel list [CANCEL_HONORED]", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const claimed = await h.call("claim", claim(runner.runnerId), runner);

    await h.app.cancel(handle.id);

    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeLeases: leasesFrom(claimed),
        paused: false,
      },
      runner,
    );
    expect((res.body as { cancel: { jobId: string }[] }).cancel).toEqual([
      { jobId: handle.id, leaseId: leasesFrom(claimed)[0]?.leaseId },
    ]);
  });
});

describe("result [RESULT_IDEMPOTENT, PROVENANCE_NAMES_DEVICE]", () => {
  async function claimOne(
    h: ReturnType<typeof createHarness>,
    runner: PairedRunner,
  ) {
    // The lease travels with the stub, and tests about `LEASE_HONORED` need
    // the grant they were given rather than whatever is current when they ask.
    const res = await h.call("claim", claim(runner.runnerId), runner);
    return (res.body as { jobs: { id: string; lease: { id: string } }[] })
      .jobs[0]!;
  }

  it("records the first outcome and discards the second", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await claimOne(h, runner);

    const first = await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "first" },
      }),
      runner,
    );
    expect((first.body as { accepted: boolean }).accepted).toBe(true);

    // A genuinely different second result, sealed and signed as properly as
    // the first — so what makes it lose is idempotency, not a rejected
    // envelope. Reusing the first body would have tested nothing.
    const second = await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "second" },
      }),
      runner,
    );
    expect((second.body as { accepted: boolean }).accepted).toBe(false);

    const delivered = await h.app.result(handle.id);
    expect(delivered?.outcome).toMatchObject({ text: "first" });
  });

  it("marks a self result trusted and a public one untrusted", async () => {
    const h = createHarness();
    const alice = await h.pair({ owner: "alice" });
    const selfJob = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "private",
    });
    await claimOne(h, alice);
    await h.call(
      "result",
      await h.resultBody({
        jobId: selfJob.id,
        runner: alice,
        outcome: { outcome: "ok", text: "mine" },
        model: "gemma4:26b",
        backendClass: "http",
      }),
      alice,
    );
    expect((await h.app.result(selfJob.id))?.provenance?.untrusted).toBe(false);

    const bob = await h.pair({
      owner: "bob",
      capabilities: httpCapabilities("team"),
    });
    const publicJob = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "team",
    });
    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("team"),
        max: 4,
      },
      bob,
    );
    expect((claimed.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    await h.call(
      "result",
      await h.resultBody({
        jobId: publicJob.id,
        runner: bob,
        outcome: { outcome: "ok", text: "from a stranger's machine" },
        model: "gemma4:26b",
        backendClass: "http",
      }),
      bob,
    );
    const delivered = await h.app.result(publicJob.id);
    expect(delivered?.provenance).toMatchObject({
      untrusted: true,
      audience: "team",
      runnerOwner: "bob",
    });
  });

  it("refuses a result from a runner that no longer holds the lease [LEASE_HONORED]", async () => {
    const h = createHarness({ leaseMs: 10_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await claimOne(h, runner);

    h.clock.advance(11_000);
    await h.app.sweep();

    const res = await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner: runner,
        outcome: { outcome: "ok", text: "too late" },
        model: "gemma4:26b",
        backendClass: "http",
      }),
      runner,
    );
    expect((res.body as { accepted: boolean }).accepted).toBe(false);
  });

  it("refuses a result from the grant before this one [LEASE_HONORED]", async () => {
    // The case the test above cannot see, and the one that actually happens.
    //
    // After a sweep the job has no holder at all, so "match the runner" and
    // "match the lease" both refuse — the check passes identically whichever
    // rule is in force, which is why reverting `result` to the runner id broke
    // nothing. The distinguishing case is a **re-claim by the same runner**:
    // the id still matches, and only the grant has changed.
    //
    // It is not hypothetical. Tracing a mutation in cloud_008 §0.6 produced
    // exactly this sequence — lease lapsed, sweep requeued, same daemon
    // claimed again, and the original run finished and posted under the old
    // grant.
    const h = createHarness({ leaseMs: 10_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const first = await claimOne(h, runner);

    h.clock.advance(11_000);
    await h.app.sweep();
    const second = await claimOne(h, runner);
    expect(second.lease.id).not.toBe(first.lease.id);

    const res = await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "from the grant that ended" },
        leaseId: first.lease.id,
      }),
      runner,
    );

    expect((res.body as { accepted: boolean }).accepted).toBe(false);
    // And the job is still the current grant's to finish.
    const job = await h.store.get(handle.id);
    expect(job?.outcome).toBeNull();
    expect(job?.lease?.id).toBe(second.lease.id);
  });

  it("takes the model from the envelope, not from beside it [PROVENANCE_NAMES_DEVICE]", async () => {
    // cloud_008 §2.5. `model`, `backendClass` and `durationMs` used to travel
    // in the clear on `ResultRequest`, so a site recorded unauthenticated
    // fields next to an authenticated answer — a daemon could seal one result
    // and declare it came from something else, and only the unsigned half
    // reached the app.
    //
    // They are inside the envelope now, which makes them the device's signed
    // statement about its own run. The check is that the *sealed* value wins,
    // so this seals one model and puts another in the request body: the
    // schema is `.strict()`, so the extra field is refused outright rather
    // than silently preferred — which is the stronger of the two outcomes and
    // the one worth pinning.
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await claimOne(h, runner);

    const honest = await h.resultBody({
      jobId: handle.id,
      runner,
      outcome: { outcome: "ok", text: "sealed by a real model" },
      model: "the-model-that-ran",
    });
    const res = await h.call(
      "result",
      { ...honest, model: "a-model-nobody-ran" },
      runner,
    );

    expect(res.status).toBe(400);
    expect(await h.store.get(handle.id)).toMatchObject({ state: "claimed" });
  });

  it("records the model the device sealed [PROVENANCE_NAMES_DEVICE]", async () => {
    // The positive control, and the half that actually reaches the app: the
    // provenance an app reads is the one the device signed.
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await claimOne(h, runner);

    await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "done" },
        model: "gemma4:26b",
        backendClass: "process",
      }),
      runner,
    );

    const job = await h.store.get(handle.id);
    expect(job?.provenance?.model).toBe("gemma4:26b");
    expect(job?.provenance?.backendClass).toBe("process");
  });

  it("404s an unknown job", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const res = await h.call(
      "result",
      await h.resultBody({
        jobId: "job_nope",
        runner: runner,
        outcome: { outcome: "ok", text: "x" },
        model: "m",
        backendClass: "http",
      }),
      runner,
    );
    expect(res.status).toBe(404);
  });
});

describe("release [REFUSAL_NOT_REOFFERED]", () => {
  it("requeues a released job for another runner", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const claimed = await h.call("claim", claim(runner.runnerId), runner);

    await h.call(
      "release",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        leases: leasesFrom(claimed),
        reason: "shutdown",
      },
      runner,
    );
    expect((await h.app.job(handle.id))?.state).toBe("queued");

    // Same runner may take it again — a shutdown is not a refusal.
    const again = await h.call("claim", claim(runner.runnerId), runner);
    expect((again.body as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("never re-offers a job to the runner that refused it", async () => {
    const h = createHarness();
    const bob = await h.pair({
      owner: "bob",
      capabilities: httpCapabilities("team"),
    });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "team",
    });

    const capabilities = httpCapabilities("team");
    const first = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities,
        max: 4,
      },
      bob,
    );
    expect((first.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    // Bob's local allowlist does not name alice, so his daemon declines.
    await h.call(
      "release",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        leases: leasesFrom(first),
        reason: "refused",
      },
      bob,
    );

    // Without refusal tracking this would loop forever.
    const second = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: bob.runnerId,
        capabilities,
        max: 4,
      },
      bob,
    );
    expect((second.body as { jobs: unknown[] }).jobs).toHaveLength(0);
    expect((await h.app.job(handle.id))?.state).toBe("queued");
  });
});

describe("a lease names the grant, not just its holder", () => {
  // The hole this closes, found in review after signed requests shipped:
  //
  //   1. runner claims J           -> lease A
  //   2. runner releases J         -> a genuinely signed request
  //   3. backend recovers, runner re-claims J -> lease B
  //   4. a relay replays the step-2 request inside the freshness window
  //
  // Matching on runner id alone, step 4 released lease B. The job returned to
  // the queue while the daemon was mid-execution, and the work ran twice on
  // the owner's hardware — RESULT_IDEMPOTENT dedupes the *result*, not the
  // compute. With `reason: "refused"` it was worse: the replay also barred the
  // legitimate re-claim, stranding the job.
  const enqueue = (h: ReturnType<typeof createHarness>) =>
    h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });

  it("ignores a replayed release aimed at a lease that has been superseded", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await enqueue(h);

    const first = await h.call("claim", claim(runner.runnerId), runner);
    const staleRelease = {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: runner.runnerId,
      leases: leasesFrom(first),
      reason: "backend-down" as const,
    };
    await h.call("release", staleRelease, runner);

    // Backend recovers; the same runner takes it again. A different grant.
    const second = await h.call("claim", claim(runner.runnerId), runner);
    expect(leasesFrom(second)[0]?.leaseId).not.toBe(
      leasesFrom(first)[0]?.leaseId,
    );

    // The relay replays the earlier, genuinely signed release.
    const replayed = await h.call("release", staleRelease, runner);
    expect((replayed.body as { released: string[] }).released).toEqual([]);

    // The daemon still holds the job it is executing.
    const job = await h.app.job(handle.id);
    expect(job?.state).toBe("claimed");
    expect(job?.lease?.id).toBe(leasesFrom(second)[0]?.leaseId);
  });

  it("does not let a replayed refusal strand a job", async () => {
    const h = createHarness();
    const runner = await h.pair();
    await enqueue(h);

    const first = await h.call("claim", claim(runner.runnerId), runner);
    const staleRefusal = {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: runner.runnerId,
      leases: leasesFrom(first),
      reason: "refused" as const,
    };
    await h.call("release", staleRefusal, runner);

    // A second runner picks it up.
    const other = await h.pair({ owner: "alice", label: "other" });
    const second = await h.call("claim", claim(other.runnerId), other);
    expect(leasesFrom(second)).toHaveLength(1);

    // Replaying the first runner's refusal must not touch the second's lease.
    await h.call("release", staleRefusal, runner);
    expect((await h.app.job(leasesFrom(second)[0]!.jobId))?.state).toBe(
      "claimed",
    );
  });

  it("still releases the lease actually named", async () => {
    // The fix must not turn release into a no-op.
    const h = createHarness();
    const runner = await h.pair();
    const handle = await enqueue(h);
    const claimed = await h.call("claim", claim(runner.runnerId), runner);

    const res = await h.call(
      "release",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        leases: leasesFrom(claimed),
        reason: "shutdown",
      },
      runner,
    );
    expect((res.body as { released: string[] }).released).toEqual([handle.id]);
    expect((await h.app.job(handle.id))?.state).toBe("queued");
  });
});
