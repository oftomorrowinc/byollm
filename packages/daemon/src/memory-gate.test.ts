import { describe, expect, it } from "vitest";
import { resolveCost } from "@byollm/protocol";
import { DaemonConfig, resolveConfig } from "./config.js";
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
/** Todd's MLX server: the generic backend at a loopback address. */
const MLX_SERVER = {
  backendId: "openai-http",
  baseUrl: "http://127.0.0.1:6999/v1",
  model: "qwen-2.5-14b",
} as const;

/** A local Ollama, which declares its cost rather than having it classified. */
const LOCAL = {
  backendId: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2",
} as const;

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
      ...LOCAL,
      memory: reading(8),
      pressure: "normal",
    });
    const dire = memoryGate({
      ...LOCAL,
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
    for (const service of [
      { backendId: "claude-cli", baseUrl: undefined, model: "sonnet" },
      { backendId: "codex-cli", baseUrl: undefined, model: "gpt-5-codex" },
      {
        backendId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "glm-5.2:cloud",
      },
      MLX_SERVER,
    ] as const) {
      const decision = memoryGate({ ...service, ...TODDS_MACHINE });
      expect(
        decision.admit,
        `${service.backendId}/${service.model} was refused: ${decision.why}`,
      ).toBe(true);
    }

    /* And the half that makes this an acceptance test rather than a tautology:
       his MLX server is CHECKED, not exempted. If it were skipped as a proxy
       the loop above would pass while the guard did nothing for him. */
    expect(
      resolveCost(MLX_SERVER.backendId, MLX_SERVER.baseUrl, MLX_SERVER.model),
    ).toBe("free");
  });

  it("does not refuse at `warn`, because this machine sits there", () => {
    /* Verified, not assumed: `kern.memorystatus_vm_pressure_level` reads 2
       stably on a Mac holding 6.6 GB and serving jobs. Refusing at warn would
       refuse tonight, which its owner would rightly call broken. */
    expect(memoryGate({ ...LOCAL, ...TODDS_MACHINE }).admit).toBe(true);
  });

  it("refuses at `critical`, where the kernel is already killing things", () => {
    const decision = memoryGate({
      ...LOCAL,
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
    for (const service of [
      { backendId: "anthropic", baseUrl: undefined, model: "claude-opus-4" },
      { backendId: "openai", baseUrl: undefined, model: "gpt-5" },
      { backendId: "claude-cli", baseUrl: undefined, model: "sonnet" },
      { backendId: "codex-cli", baseUrl: undefined, model: "gpt-5-codex" },
      /* The generic backend belongs here only because its address is remote —
         never because of what it is. */
      {
        backendId: "openai-http",
        baseUrl: "https://api.together.xyz/v1",
        model: "qwen-2.5-14b",
      },
    ] as const) {
      const decision = memoryGate({
        ...service,
        memory: reading(0.1),
        pressure: "critical",
      });
      expect(decision.admit, service.backendId).toBe(true);
      expect(decision.why).toContain("holds no model here");
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
        memoryGate({
          backendId,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "llama3.2",
          memory: reading(0.1),
          pressure: "normal",
        }).admit,
        backendId,
      ).toBe(false);
    }
  });

  it("admits when memory cannot be read, and says the guard is off", () => {
    /* Refusing where we cannot measure bricks the daemon on a platform
       nobody has visited; admitting silently means nobody knows the guard is
       absent. */
    const decision = memoryGate({
      ...LOCAL,
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
      ...LOCAL,
      memory: reading(4, { free: 0, total: 0 }),
      pressure: "normal",
    });
    expect(hostedBox.admit, hostedBox.why).toBe(true);

    /* And the control: swap that EXISTS and is gone is a real signal. */
    const exhausted = memoryGate({
      ...LOCAL,
      memory: reading(4, { free: 0, total: 15 }),
      pressure: "normal",
    });
    expect(exhausted.admit).toBe(false);
  });

  it("checks a LOCAL openai-http, and skips a remote one — the same id, both ways", () => {
    /**
     * The regression for `846a683`, which read `BACKENDS[id].cost` directly.
     *
     * `openai-http` declares `cost: null` — it is the one backend whose cost
     * is classified from its address rather than declared — so `!== "free"`
     * was true and the gate admitted it without looking at memory. That is
     * the documented way to reach a local model server, and it is what Todd's
     * MLX server on port 6999 is.
     *
     * Both directions from one id, because a gate that answers "check" for
     * every openai-http would be as wrong as one that answers "skip": the
     * address decides, and the test has to show the address deciding.
     */
    const local = memoryGate({
      ...MLX_SERVER,
      memory: reading(0.1),
      pressure: "normal",
    });
    const remote = memoryGate({
      backendId: "openai-http",
      baseUrl: "https://api.together.xyz/v1",
      model: "qwen-2.5-14b",
      memory: reading(0.1),
      pressure: "normal",
    });
    expect(local.admit, `a local model server was skipped: ${local.why}`).toBe(
      false,
    );
    expect(remote.admit, remote.why).toBe(true);
    expect(local.admit).not.toBe(remote.admit);

    /**
     * And the narrowness of the fix, stated rather than assumed.
     *
     * A named provider's declared cost is the registry's word
     * [COST_NOT_CONFIGURABLE], and it is consulted before the model tag — so
     * `ollama` serving `glm-5.2:cloud` resolves `free` and IS checked, even
     * though that job runs on Ollama's cloud and needs no memory here.
     *
     * That is the harmless direction: refusing a cloud-proxied job on a
     * machine with 100 MB free costs its owner a retry, while the reverse
     * skipped the check on the local server this row exists for.
     */
    expect(
      resolveCost("ollama", "http://127.0.0.1:11434/v1", "glm-5.2:cloud"),
    ).toBe("free");
    expect(
      memoryGate({
        backendId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "glm-5.2:cloud",
        memory: reading(0.1),
        pressure: "normal",
      }).admit,
    ).toBe(false);
  });

  it("passes the model, because a loopback address alone does not mean local", () => {
    /**
     * The third argument, and the reason it is not decoration: `openai-http`
     * pointed at `127.0.0.1:11434` serving a `:cloud`-tagged model is Ollama
     * proxying somebody's hosted account through a local port. The address
     * says local; the tag says the work leaves.
     *
     * A mutation that dropped the model from the {@link resolveCost} call
     * survived the rest of this suite — the same partial-asker gap that
     * signature was hardened against. So it is pinned here.
     */
    const cloudThroughLoopback = {
      backendId: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "glm-5.2:cloud",
    } as const;
    expect(
      resolveCost(
        cloudThroughLoopback.backendId,
        cloudThroughLoopback.baseUrl,
        cloudThroughLoopback.model,
      ),
    ).toBe("metered");
    expect(
      memoryGate({
        ...cloudThroughLoopback,
        memory: reading(0.1),
        pressure: "normal",
      }).admit,
    ).toBe(true);

    /* The control on the same address: drop the cloud tag and it is checked,
       so this proves the MODEL decided and not the port. */
    expect(
      memoryGate({
        ...cloudThroughLoopback,
        model: "llama3.2",
        memory: reading(0.1),
        pressure: "normal",
      }).admit,
    ).toBe(false);
  });

  it("agrees with the cost the config already resolved, so the two cannot drift", () => {
    /**
     * The gate asks {@link resolveCost}; `resolveConfig` asked
     * `classifyCost` when it built the route. Same question, two call sites —
     * which is safe only while they cannot disagree, so that is asserted
     * rather than assumed.
     */
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          mlx: {
            type: "openai-http",
            baseUrl: MLX_SERVER.baseUrl,
            model: MLX_SERVER.model,
            kinds: ["llm.chat"],
          },
        },
      }),
    );
    expect(problems, JSON.stringify(problems)).toEqual([]);
    const route = routes[0];
    expect(route).toBeDefined();
    if (route === undefined) return;

    expect(route.cost).toBe(
      resolveCost(route.backendId, route.baseUrl, route.model),
    );
    /* The route as the runner will hand it over, refused when memory is dire. */
    expect(
      memoryGate({
        backendId: route.backendId,
        baseUrl: route.baseUrl,
        model: route.model,
        memory: reading(0.1),
        pressure: "normal",
      }).admit,
    ).toBe(false);
  });

  it("rests on an unreachable premise, so the premise is checked", () => {
    /**
     * The gate defers to `resolveCost`, whose one unknown-shaped answer —
     * `metered` because the address is absent or unreadable — would make it
     * skip a check it should run. That is the wrong failure direction for a
     * guard, and it is unreachable rather than handled: `resolveConfig`
     * refuses an HTTP-class service without a usable `baseUrl`, so no such
     * service is ever dispatched.
     *
     * A prediction ships with the test that catches it. If the schema is ever
     * loosened, this goes red next to the comment that relies on it.
     */
    for (const baseUrl of [undefined, "not://a real url", "howdy"]) {
      const { routes, problems } = resolveConfig(
        DaemonConfig.parse({
          services: {
            broken: {
              type: "openai-http",
              ...(baseUrl === undefined ? {} : { baseUrl }),
              model: "qwen-2.5-14b",
              kinds: ["llm.chat"],
            },
          },
        }),
      );
      expect(
        problems.length,
        `${String(baseUrl)} was accepted`,
      ).toBeGreaterThan(0);
      expect(routes, `${String(baseUrl)} produced a route`).toEqual([]);
    }

    /* The control: the address that IS usable produces a route. Without this
       the loop above would pass against a config layer that refuses
       everything. */
    expect(
      resolveConfig(
        DaemonConfig.parse({
          services: {
            fine: {
              type: "openai-http",
              baseUrl: MLX_SERVER.baseUrl,
              model: MLX_SERVER.model,
              kinds: ["llm.chat"],
            },
          },
        }),
      ).routes.length,
    ).toBe(1);
  });

  it("has a floor low enough not to fire in ordinary use", () => {
    /* 8 GB would have refused on the machine this row exists for, tonight. */
    expect(DEFAULT_FLOOR_BYTES).toBeLessThan(6.6 * GB);
    expect(DEFAULT_FLOOR_BYTES).toBeGreaterThan(0);
  });
});
