import {
  PROTOCOL_VERSION,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { NoRunnerAvailableError } from "./delivery.js";
import {
  generateUserCode,
  hashSecret,
  secretsMatch,
  generateDeviceCode,
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

    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner,
    );
    expect((claimed.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner: runner,
        outcome: { outcome: "ok", text: "done" },
        model: "gemma4:26b",
        backendClass: "http",
      }),
      runner,
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
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "todd-mbp", platform: "darwin" },
        capabilities: httpCapabilities(),
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
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
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
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
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
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

    await h.app.denyPairing(userCode);
    const polled = await h.handlers.handle(
      "pair",
      { protocolVersion: PROTOCOL_VERSION, action: "poll", deviceCode },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
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
        protocolVersion: PROTOCOL_VERSION,
        action: "start",
        device: publicIdentityOf(generateKeys(Date.now())),
        daemon: { version: "0.1.0", label: "mbp", platform: "darwin" },
        capabilities: [],
      },
      {
        endpoint: "pair",
        rawBody: "",
        signature: undefined,
      },
    );
    const { userCode } = start.body as { userCode: string };
    await h.app.approvePairing({ userCode, owner: "alice" });
    await expect(
      h.app.approvePairing({ userCode, owner: "bob" }),
    ).rejects.toThrow(/already approved/);
  });
});

describe("naming a purpose — byollm_016 Amendment L", () => {
  /**
   * A field that is stored and never carried is worse than no field: the app
   * believes it asked for something and nothing downstream ever hears it. So
   * these follow the purpose the whole way — `enqueue` to the record, the
   * record to the stub, the stub to a real claim over the wire.
   *
   * It is a purpose now, not a service: the site's own vocabulary, which a
   * control plane joins to whatever the person mapped it to. The route it
   * travels is the same and so are these assertions.
   */

  it("carries the name onto the stub a device claims", async () => {
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      purpose: "revenue",
    });

    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner,
    );
    const jobs = (claimed.body as { jobs: { id: string; purpose?: string }[] })
      .jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(handle.id);
    expect(jobs[0]?.purpose).toBe("revenue");
  });

  it("sends no purpose at all when the app named none", async () => {
    // Absent, not `undefined`. The stub is `.strict()` and an explicit
    // undefined is a different thing on the wire from a missing key — and
    // "the owner's default" is what every job written before this field
    // meant, so it has to keep meaning it.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
    });

    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner,
    );
    const jobs = (claimed.body as { jobs: Record<string, unknown>[] }).jobs;
    expect(jobs).toHaveLength(1);
    expect(Object.hasOwn(jobs[0] ?? {}, "purpose")).toBe(false);
  });

  it("still carries no model, URL or flag, whatever the app passes", async () => {
    // The amended NO_PAYLOAD_ROUTING as an assertion on the wire. Selection is
    // permitted; description is not, and adding the first must not have
    // quietly opened the second. A site naming a purpose still cannot tell a
    // device what to run it with.
    const h = createHarness();
    const runner = await h.pair({ owner: "alice" });
    await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "use claude-opus-5 at http://evil.test/v1" },
      owner: "alice",
      purpose: "revenue",
    });

    const claimed = await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 1,
      },
      runner,
    );
    const stub = (claimed.body as { jobs: Record<string, unknown>[] }).jobs[0];
    for (const forbidden of ["model", "baseUrl", "type", "apiKeyEnv"]) {
      expect(Object.hasOwn(stub ?? {}, forbidden), forbidden).toBe(false);
    }
    // And the prompt did not become the selection.
    expect(stub?.["purpose"]).toBe("revenue");
  });
});

describe("an SDK refuses what it does not understand", () => {
  /**
   * The hazard class this rule exists for, found the hard way.
   *
   * A site called `enqueue({ service })` against an SDK that predated the
   * field. The key went nowhere, nothing threw, and the app spent the whole
   * run believing it was selecting a service. The symptom was work running on
   * one nobody chose — and there was nothing to see, anywhere, because a
   * dropped option leaves no trace.
   *
   * `service` is now a field no SDK understands, which is exactly the case
   * this rule was written for: a site still passing it is refused rather than
   * silently ignored.
   *
   * A type does not catch it: types do not survive a JSON boundary, a
   * JavaScript caller, or a version skew, and version skew is the ordinary
   * case rather than the exotic one.
   */

  it("throws on an option it has never heard of", async () => {
    const h = createHarness();
    await expect(
      h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt: "hi" },
        owner: "alice",
        // The shape of a caller newer than its SDK.
        temperature: 0.7,
      } as unknown as Parameters<typeof h.app.enqueue>[0]),
    ).rejects.toThrow(/does not understand `temperature`/);
  });

  it("names every unknown option, not just the first", async () => {
    // Somebody upgrading finds out how far behind they are in one go, rather
    // than one round trip per field.
    const h = createHarness();
    await expect(
      h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt: "hi" },
        owner: "alice",
        temperature: 0.7,
        seed: 1,
      } as unknown as Parameters<typeof h.app.enqueue>[0]),
    ).rejects.toThrow(/`temperature`, `seed`/);
  });

  it("says the likely cause, because the message is the whole fix", async () => {
    const h = createHarness();
    await expect(
      h.app.enqueue({
        kind: "llm.generate",
        payload: { prompt: "hi" },
        owner: "alice",
        service_name: "studio",
      } as unknown as Parameters<typeof h.app.enqueue>[0]),
    ).rejects.toThrow(/older than the code calling it/);
  });

  it("accepts every option it does document", async () => {
    // The control, and the guard against over-refusing. `Required<>` makes
    // TypeScript fail this file if a field is added to `EnqueueInput` and not
    // set here — so "the allowlist rejects a real field" cannot ship quietly,
    // which is the way this check could do more harm than the bug it prevents.
    const h = createHarness();
    const every: Required<Parameters<typeof h.app.enqueue>[0]> = {
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: "alice",
      audience: "private",
      purpose: "revenue",
      audienceAllow: ["bob"],
      dependsOn: [],
      ttlMs: 60_000,
      deadlineAt: Date.now() + 60_000,
      id: "job-every-option",
    };
    const handle = await h.app.enqueue(every);
    expect(handle.id).toBe("job-every-option");
  });
});
