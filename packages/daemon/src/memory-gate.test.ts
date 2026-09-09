import { describe, expect, it } from "vitest";
import { DEFAULT_FLOOR_BYTES, memoryGate } from "./memory-gate.js";
import type { MemoryReading } from "./memory.js";

const GB = 1024 ** 3;
const reading = (
  availableGb: number,
  swap?: { free: number; total: number },
): MemoryReading => ({
  kind: "read",
  availableBytes: availableGb * GB,
  totalBytes: 36 * GB,
  ...(swap === undefined
    ? {}
    : { swapFreeBytes: swap.free * GB, swapTotalBytes: swap.total * GB }),
});

/** This Mac, measured tonight: 6.6 GB available, pressure `warn`, swap 93% used. */
const TODDS_MACHINE = {
  memory: reading(6.6, { free: 1.08, total: 15 }),
  pressure: "warn" as const,
};

describe("the memory gate", () => {
  it("admits and refuses from the same reader, which is the whole test", () => {
    /**
     * byollm_021's shape, and the spec calls it non-optional here: a test
     * that only asserts "refuses when memory is low" passes against a gate
     * that refuses ALWAYS — which is the `os.freemem()` failure mode, broken
     * closed, and the thing that would make this worse than not shipping.
     *
     * So both cases, one backend, one call, proving the two are
     * distinguishable rather than proving a constant.
     */
    const roomy = memoryGate({
      backendId: "ollama",
      memory: reading(8),
      pressure: "normal",
    });
    const dire = memoryGate({
      backendId: "ollama",
      memory: reading(0.4),
      pressure: "normal",
    });
    expect(roomy.admit).toBe(true);
    expect(dire.admit).toBe(false);
    expect(
      roomy.admit,
      "a gate that answers the same either way is not a gate",
    ).not.toBe(dire.admit);
  });

  it("never refuses any of Todd's four authorised services on his machine", () => {
    /**
     * The acceptance test, and it is better than any number: it is the
     * owner's own statement of what correct looks like. If the gate fires
     * here the default is wrong, not his machine.
     *
     * His config tonight: claude (subscription), codex (subscription),
     * glm-5.2:cloud (proxied to Ollama's cloud), qwen 14B on MLX — which he
     * says runs unnoticed. Measured state: 6.6 GB available, pressure warn,
     * swap 93% used.
     */
    for (const backendId of [
      "claude-cli",
      "codex-cli",
      "openai-http",
      "mlx",
    ] as const) {
      const decision = memoryGate({ backendId, ...TODDS_MACHINE });
      expect(decision.admit, `${backendId} was refused: ${decision.why}`).toBe(
        true,
      );
    }
  });

  it("does not refuse at `warn`, because this machine sits there", () => {
    /* Verified, not assumed: `kern.memorystatus_vm_pressure_level` reads 2
       stably on a Mac holding 6.6 GB and serving jobs. Refusing at warn would
       refuse tonight, which its owner would rightly call broken. */
    expect(memoryGate({ backendId: "ollama", ...TODDS_MACHINE }).admit).toBe(
      true,
    );
  });

  it("refuses at `critical`, where the kernel is already killing things", () => {
    const decision = memoryGate({
      backendId: "ollama",
      memory: reading(8),
      pressure: "critical",
    });
    expect(decision.admit).toBe(false);
    expect(decision.why).toContain("critical");
  });

  it("skips proxy backends entirely, which is what makes hosted boxes inert", () => {
    /* Derived from BACKENDS rather than a list: only `cost: "free"` serves a
       model out of local memory. A hosted box runs only proxies, so there is
       nothing there for this to protect — by construction, not by luck. */
    for (const backendId of [
      "anthropic",
      "openai",
      "claude-cli",
      "codex-cli",
    ] as const) {
      const decision = memoryGate({
        backendId,
        memory: reading(0.1),
        pressure: "critical",
      });
      expect(decision.admit, backendId).toBe(true);
      expect(decision.why).toContain("proxy");
    }
  });

  it("checks the backends that DO hold a model, or the exemption is everything", () => {
    /* The control on the case above. If every backend were exempt the suite
       would be green and the gate would not exist. */
    for (const backendId of [
      "ollama",
      "mlx",
      "llamacpp",
      "vllm",
      "lmstudio",
      "jan",
      "localai",
    ] as const) {
      expect(
        memoryGate({ backendId, memory: reading(0.1), pressure: "normal" })
          .admit,
        backendId,
      ).toBe(false);
    }
  });

  it("admits when memory cannot be read, and says the guard is off", () => {
    /* Refusing where we cannot measure bricks the daemon on a platform
       nobody has visited; admitting silently means nobody knows the guard is
       absent. */
    const decision = memoryGate({
      backendId: "ollama",
      memory: { kind: "unknown", why: "no memory reader for freebsd" },
      pressure: "unknown",
    });
    expect(decision.admit).toBe(true);
    expect(decision.why).toContain("not active");
  });

  it("treats no swap as no swap, never as exhausted swap", () => {
    /**
     * The landmine. Kubernetes nodes run without swap, so every hosted box
     * reads `SwapTotal: 0` — and "refuse when swap headroom is gone", written
     * carelessly, refuses every job on every box forever. A ratio there is
     * 0/0.
     *
     * Third time this week the same distinction decided a design: absent is
     * not empty, the way `unavailable` is not `unverified` and `"unknown"` is
     * not `"end"`.
     */
    const hostedBox = memoryGate({
      backendId: "ollama",
      memory: reading(4, { free: 0, total: 0 }),
      pressure: "normal",
    });
    expect(hostedBox.admit, hostedBox.why).toBe(true);

    /* And the control: swap that EXISTS and is gone is a real signal. */
    const exhausted = memoryGate({
      backendId: "ollama",
      memory: reading(4, { free: 0, total: 15 }),
      pressure: "normal",
    });
    expect(exhausted.admit).toBe(false);
  });

  it("has a floor low enough not to fire in ordinary use", () => {
    /* 8 GB would have refused on the machine this row exists for, tonight. */
    expect(DEFAULT_FLOOR_BYTES).toBeLessThan(6.6 * GB);
    expect(DEFAULT_FLOOR_BYTES).toBeGreaterThan(0);
  });
});
