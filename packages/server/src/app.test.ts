import { describe, expect, it } from "vitest";
import { NoRunnerAvailableError } from "./delivery.js";
import {
  generateUserCode,
  hashSecret,
  secretsMatch,
  generateDeviceCode,
  generateRunnerToken,
} from "./ids.js";
import { normalizeUserCode } from "./app.js";
import { capabilityFor } from "./memory.js";
import { createHarness, httpCapabilities } from "./testing.js";

describe("normalizeUserCode", () => {
  it.each([
    ["KRTZ-9F2Q", "KRTZ-9F2Q"],
    ["krtz9f2q", "KRTZ-9F2Q"],
    ["krtz 9f2q", "KRTZ-9F2Q"],
    ["  KRTZ--9F2Q  ", "KRTZ-9F2Q"],
  ])("accepts %s however it was typed", (input, expected) => {
    // A user who mistypes the formatting should not get a failure they cannot
    // diagnose from a detail nobody told them mattered.
    expect(normalizeUserCode(input)).toBe(expected);
  });

  it("leaves a code of the wrong length alone rather than mangling it", () => {
    expect(normalizeUserCode("SHORT")).toBe("SHORT");
  });
});

describe("id and secret helpers", () => {
  it("generates user codes from an unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      // 0/O, 1/I/L, 5/S and U/V are excluded — they get misread aloud.
      expect(code).not.toMatch(/[OILSUV015]/);
    }
  });

  it("generates distinct, long secrets", () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateDeviceCode()),
    );
    expect(codes.size).toBe(50);
    expect(generateRunnerToken().length).toBeGreaterThan(20);
  });

  it("hashes a secret to a stable 64-char digest", () => {
    expect(hashSecret("abc")).toHaveLength(64);
    expect(hashSecret("abc")).toBe(hashSecret("abc"));
    expect(hashSecret("abc")).not.toBe(hashSecret("abd"));
  });

  it("compares digests without throwing on a length mismatch", () => {
    expect(secretsMatch(hashSecret("a"), hashSecret("a"))).toBe(true);
    expect(secretsMatch(hashSecret("a"), hashSecret("b"))).toBe(false);
    expect(secretsMatch("abc", hashSecret("a"))).toBe(false);
  });
});

describe("capabilityFor", () => {
  it("finds the capability serving a kind, or nothing", () => {
    const caps = httpCapabilities();
    expect(capabilityFor(caps, "llm.chat")?.kind).toBe("llm.chat");
    expect(capabilityFor(caps, "llm.nope")).toBeUndefined();
    expect(capabilityFor([], "llm.chat")).toBeUndefined();
  });
});

describe("ByollmApp — the app-facing surface", () => {
  it("returns a handle whose result resolves once the job finishes", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });

    const claimed = await h.handlers.handle(
      "claim",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner.token,
    );
    expect((claimed.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    await h.handlers.handle(
      "result",
      {
        protocolVersion: "0",
        runnerId: runner.runnerId,
        jobId: handle.id,
        outcome: { outcome: "ok", text: "done" },
        model: "gemma4:26b",
        backendClass: "http",
        durationMs: 1,
      },
      runner.token,
    );

    const result = await handle.result({ timeoutMs: 5_000 });
    expect(result.outcome).toMatchObject({ text: "done" });
  });

  it("rejects with noRunnerAvailable rather than hanging forever", async () => {
    const h = createHarness({ noRunnerGraceMs: 0 });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await expect(handle.result({ timeoutMs: 30_000 })).rejects.toBeInstanceOf(
      NoRunnerAvailableError,
    );
  });

  it("lets onNoRunner substitute a hosted answer", async () => {
    const h = createHarness({ noRunnerGraceMs: 0 });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    const result = await handle.result({
      onNoRunner: () => ({
        jobId: handle.id,
        state: "ok" as const,
        outcome: { outcome: "ok" as const, text: "from the hosted model" },
      }),
    });
    expect(result.outcome).toMatchObject({ text: "from the hosted model" });
  });

  it("cancels through the handle", async () => {
    const h = createHarness();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    await handle.cancel();
    expect((await h.app.job(handle.id))?.state).toBe("canceled");
  });

  it("returns null for an unknown job and an unknown result", async () => {
    const h = createHarness();
    expect(await h.app.job("job_nope")).toBeNull();
    expect(await h.app.result("job_nope")).toBeNull();
  });

  it("shows what a pending pairing is about to approve", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "start",
        daemon: { version: "0.1.0", label: "todd-mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      undefined,
    );
    const { userCode } = start.body as { userCode: string };

    const pending = await h.app.pendingPairing(userCode);
    expect(pending).toMatchObject({ label: "todd-mbp", platform: "darwin" });
    expect(pending?.capabilities).toHaveLength(2);
  });

  it("reports no pending pairing for an unknown or expired code", async () => {
    const h = createHarness();
    expect(await h.app.pendingPairing("ZZZZ-ZZZZ")).toBeNull();

    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "start",
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
      },
      undefined,
    );
    const { userCode } = start.body as { userCode: string };
    h.clock.advance(11 * 60_000);
    expect(await h.app.pendingPairing(userCode)).toBeNull();
  });

  it("denies a pairing the user did not start", async () => {
    const h = createHarness();
    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "start",
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
      },
      undefined,
    );
    const { deviceCode, userCode } = start.body as {
      deviceCode: string;
      userCode: string;
    };

    await h.app.denyPairing(userCode);
    const polled = await h.handlers.handle(
      "pair",
      { protocolVersion: "0", action: "poll", deviceCode },
      undefined,
    );
    expect(polled.body).toEqual({ status: "denied" });
  });

  it("lists a user's runners and revokes one", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    expect(await h.app.runners("alice")).toHaveLength(1);

    await h.app.revokeRunner(runner.runnerId);
    const revoked = (await h.app.runners("alice"))[0];
    expect(revoked?.revokedAt).not.toBeNull();

    // Revocation is one-way: a second call does not re-stamp it.
    const first = revoked?.revokedAt;
    h.clock.advance(1_000);
    await h.app.revokeRunner(runner.runnerId);
    expect((await h.app.runners("alice"))[0]?.revokedAt).toBe(first);
  });

  it("sweeps expired jobs on demand", async () => {
    const h = createHarness({ defaultTtlMs: 1_000 });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });
    h.clock.advance(2_000);
    expect(await h.app.sweep()).toHaveLength(1);
  });

  it("refuses to approve an unknown or already-approved pairing", async () => {
    const h = createHarness();
    await expect(
      h.app.approvePairing({ userCode: "ZZZZ-ZZZZ", owner: "alice" }),
    ).rejects.toThrow(/unknown pairing/);

    const start = await h.handlers.handle(
      "pair",
      {
        protocolVersion: "0",
        action: "start",
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
      },
      undefined,
    );
    const { userCode } = start.body as { userCode: string };
    await h.app.approvePairing({ userCode, owner: "alice" });
    await expect(
      h.app.approvePairing({ userCode, owner: "bob" }),
    ).rejects.toThrow(/already approved/);
  });
});
