import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  httpCapabilities,
  subscriptionCapabilities,
  type PairedRunner,
} from "./testing.js";

const claim = (runnerId: string, caps = httpCapabilities()) => ({
  protocolVersion: "0" as const,
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
        protocolVersion: "0",
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
      { protocolVersion: "0", action: "poll", deviceCode },
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
      { protocolVersion: "0", action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    expect(approved.body).toMatchObject({ status: "approved", owner: "alice" });
  });

  it("binds the token to exactly the approving user", async () => {
    const h = createHarness();
    const { token, owner } = await h.pair({ owner: "alice" });
    const runners = await h.app.runners("alice");
    expect(owner).toBe("alice");
    expect(runners).toHaveLength(1);
    expect(await h.app.runners("bob")).toHaveLength(0);
    expect(token.length).toBeGreaterThan(20);
  });

  it("delivers the token exactly once", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: "0",
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
      { protocolVersion: "0", action: "poll", deviceCode },
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
      { protocolVersion: "0", action: "poll", deviceCode },
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
        protocolVersion: "0",
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
      { protocolVersion: "0", action: "poll", deviceCode },
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
        protocolVersion: "0",
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
        protocolVersion: "0",
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
        protocolVersion: "0",
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
      audience: "self",
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
      capabilities: subscriptionCapabilities("public"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "public",
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        capabilities: subscriptionCapabilities("public"),
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
      capabilities: httpCapabilities("public"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "public",
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("public"),
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
      capabilities: httpCapabilities("public"),
    });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "named",
      audienceAllow: ["carol"],
    });

    const res = await h.call(
      "claim",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("public"),
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
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await h.call("claim", claim(runner.runnerId), runner);

    h.clock.advance(30_000);
    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeJobIds: [handle.id],
        paused: false,
      },
      runner,
    );
    const body = res.body as {
      leases: { jobId: string; expiresAt: number }[];
      lost: string[];
    };
    expect(body.leases).toHaveLength(1);
    expect(body.lost).toEqual([]);
  });

  it("reports a job as lost once its lease was reclaimed", async () => {
    const h = createHarness({ leaseMs: 10_000 });
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await h.call("claim", claim(runner.runnerId), runner);

    // The daemon went away for longer than its lease.
    h.clock.advance(11_000);
    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeJobIds: [handle.id],
        paused: false,
      },
      runner,
    );
    expect((res.body as { lost: string[] }).lost).toEqual([handle.id]);
  });

  it("tells a revoked runner it is revoked rather than 403ing it [REVOCATION_HONORED]", async () => {
    const h = createHarness();
    const runner = await h.pair();
    await h.app.revokeRunner(runner.runnerId);

    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeJobIds: [],
        paused: false,
      },
      runner,
    );
    expect(res.status).toBe(200);
    expect((res.body as { revoked: boolean }).revoked).toBe(true);
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
    await h.call("claim", claim(runner.runnerId), runner);

    await h.app.cancel(handle.id);

    const res = await h.call(
      "heartbeat",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        daemonVersion: "0.1.0",
        capabilities: httpCapabilities(),
        activeJobIds: [handle.id],
        paused: false,
      },
      runner,
    );
    expect((res.body as { cancel: string[] }).cancel).toEqual([handle.id]);
  });
});

describe("result [RESULT_IDEMPOTENT, RESULT_PROVENANCE]", () => {
  async function claimOne(
    h: ReturnType<typeof createHarness>,
    runner: PairedRunner,
  ) {
    const res = await h.call("claim", claim(runner.runnerId), runner);
    return (res.body as { jobs: { id: string }[] }).jobs[0]!;
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

    const body = {
      protocolVersion: "0" as const,
      runnerId: runner.runnerId,
      jobId: handle.id,
      outcome: { outcome: "ok" as const, text: "first" },
      model: "gemma4:26b",
      backendClass: "http" as const,
      durationMs: 12,
    };
    const first = await h.call("result", body, runner);
    expect((first.body as { accepted: boolean }).accepted).toBe(true);

    const second = await h.call(
      "result",
      { ...body, outcome: { outcome: "ok", text: "second" } },
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
      audience: "self",
    });
    await claimOne(h, alice);
    await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: alice.runnerId,
        jobId: selfJob.id,
        outcome: { outcome: "ok", text: "mine" },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 1,
      },
      alice,
    );
    expect((await h.app.result(selfJob.id))?.provenance?.untrusted).toBe(false);

    const bob = await h.pair({
      owner: "bob",
      capabilities: httpCapabilities("public"),
    });
    const publicJob = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "public",
    });
    const claimed = await h.call(
      "claim",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        capabilities: httpCapabilities("public"),
        max: 4,
      },
      bob,
    );
    expect((claimed.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        jobId: publicJob.id,
        outcome: { outcome: "ok", text: "from a stranger's machine" },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 1,
      },
      bob,
    );
    const delivered = await h.app.result(publicJob.id);
    expect(delivered?.provenance).toMatchObject({
      untrusted: true,
      audience: "public",
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
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: handle.id,
        outcome: { outcome: "ok", text: "too late" },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 1,
      },
      runner,
    );
    expect((res.body as { accepted: boolean }).accepted).toBe(false);
  });

  it("404s an unknown job", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const res = await h.call(
      "result",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: "job_nope",
        outcome: { outcome: "ok", text: "x" },
        model: "m",
        backendClass: "http",
        durationMs: 1,
      },
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
    await h.call("claim", claim(runner.runnerId), runner);

    await h.call(
      "release",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobIds: [handle.id],
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
      capabilities: httpCapabilities("public"),
    });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "named",
    });

    const capabilities = httpCapabilities("public");
    const first = await h.call(
      "claim",
      { protocolVersion: "0", runnerId: bob.runnerId, capabilities, max: 4 },
      bob,
    );
    expect((first.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    // Bob's local allowlist does not name alice, so his daemon declines.
    await h.call(
      "release",
      {
        protocolVersion: "0",
        runnerId: bob.runnerId,
        jobIds: [handle.id],
        reason: "refused",
      },
      bob,
    );

    // Without refusal tracking this would loop forever.
    const second = await h.call(
      "claim",
      { protocolVersion: "0", runnerId: bob.runnerId, capabilities, max: 4 },
      bob,
    );
    expect((second.body as { jobs: unknown[] }).jobs).toHaveLength(0);
    expect((await h.app.job(handle.id))?.state).toBe("queued");
  });
});
