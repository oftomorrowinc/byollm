import { describe, expect, it } from "vitest";
import { DaemonConfig, resolveConfig } from "./config.js";

const base = {
  services: {
    local: {
      model: "gemma4:26b",
      kinds: ["llm.generate"],
      type: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  },
};

const parse = (overrides: Record<string, unknown> = {}) =>
  DaemonConfig.parse({ ...base, ...overrides });

describe("config defaults", () => {
  it("fills nested defaults without restating them", () => {
    const config = parse();
    expect(config.community.maxJobsPerHour).toBe(20);
    expect(config.ingress.communityPromptDays).toBe(7);
    expect(config.limits.maxWallClockMs).toBe(600_000);
    expect(config.concurrency).toBe(2);
  });

  it("defaults a service's offer scope to self", () => {
    expect(parse().services["local"]?.offer).toBe("self");
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // A typo'd config key that is silently dropped is a setting the owner
    // believes is in force and is not.
    expect(DaemonConfig.safeParse({ ...base, concurency: 8 }).success).toBe(
      false,
    );
  });

  it("refuses an unregistered transport type", () => {
    expect(
      DaemonConfig.safeParse({
        services: {
          x: {
            type: "curl-whatever",
            model: "m",
            kinds: ["llm.generate"],
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("resolveConfig — the subscription self-lock [SUBSCRIPTION_SELF_LOCK]", () => {
  it("ignores a widened offer on a subscription backend and says so", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          claude: {
            model: "claude-opus-5",
            kinds: ["llm.generate"],
            type: "claude-cli",
            offer: "public",
          },
        },
      }),
    );
    expect(routes[0]?.offerScope).toBe("self");
    expect(problems[0]?.message).toContain("locked to your work only");
  });

  it("honours a widened offer on an open backend", () => {
    const { routes } = resolveConfig(
      DaemonConfig.parse({
        services: {
          local: {
            model: "gemma4:26b",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            offer: "public",
          },
        },
      }),
    );
    expect(routes[0]?.offerScope).toBe("public");
  });
});

describe("resolveConfig — a broken route is dropped, not fatal", () => {
  // "a route whose backend is not defined" no longer exists as a state: a
  // service carries its own transport, so there is no second name to dangle.
  // What replaced it is ambiguity — two services answering one kind with
  // nobody saying which serves.
  it("does not advertise a kind two services claim, and says so", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          qwen: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:6999/v1",
            model: "qwen3",
            kinds: ["llm.generate"],
          },
          llama: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3.2",
            kinds: ["llm.generate"],
          },
        },
      }),
    );
    // Not advertised, deliberately. Announcing a kind it cannot resolve
    // deterministically would turn a config ambiguity into a job-time
    // mystery three hops away.
    expect(routes).toHaveLength(0);
    expect(problems[0]?.where).toBe("defaults.llm.generate");
    expect(problems[0]?.message).toContain("qwen, llama");
  });

  it("serves the kind once a default names one of them", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          qwen: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:6999/v1",
            model: "qwen3",
            kinds: ["llm.generate"],
          },
          llama: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3.2",
            kinds: ["llm.generate"],
          },
        },
        defaults: { "llm.generate": "qwen" },
      }),
    );
    expect(problems).toEqual([]);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.service).toBe("qwen");
    expect(routes[0]?.model).toBe("qwen3");
  });

  it("refuses a default naming a service that does not answer the kind", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          qwen: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:6999/v1",
            model: "qwen3",
            kinds: ["llm.generate"],
          },
          llama: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "llama3.2",
            kinds: ["llm.generate"],
          },
        },
        defaults: { "llm.generate": "claude" },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("does not answer");
  });

  it("needs no default when one service answers a kind", () => {
    const { routes, problems } = resolveConfig(DaemonConfig.parse(base));
    expect(problems).toEqual([]);
    expect(routes.map((r) => r.service)).toEqual(["local"]);
  });

  it("drops an HTTP backend with no baseUrl", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          local: { model: "m", kinds: ["llm.generate"], type: "openai-http" },
        },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("baseUrl");
  });

  it("drops an HTTP backend pointed at a metadata endpoint", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          local: {
            model: "m",
            kinds: ["llm.generate"],
            type: "openai-http",
            baseUrl: "http://169.254.169.254/v1",
          },
        },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("metadata");
  });

  it("keeps the good services when one is broken", () => {
    // A device with two services and one bad address serves the other and
    // says so, rather than refusing to start. What it must never do is
    // advertise the broken one.
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        services: {
          local: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            model: "gemma4:26b",
            kinds: ["llm.generate"],
          },
          broken: {
            type: "openai-http",
            baseUrl: "http://169.254.169.254/v1",
            model: "m",
            kinds: ["llm.chat"],
          },
        },
      }),
    );
    expect(routes.map((r) => r.kind)).toEqual(["llm.generate"]);
    expect(routes.map((r) => r.service)).toEqual(["local"]);
    expect(problems).toHaveLength(1);
  });
});

describe("byollm_007 — cost class and providers", () => {
  /** One service, named for the transport it uses, answering one kind. */
  const only = (
    name: string,
    service: Record<string, unknown>,
  ): Record<string, unknown> => ({
    services: {
      [name]: { model: "m", kinds: ["llm.generate"], ...service },
    },
  });

  it("resolves a named provider's default base URL, so an id and a key suffice", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", { type: "openai", apiKeyEnv: "OPENAI_API_KEY" }),
      }),
    );
    expect(problems).toEqual([]);
    expect(routes[0]?.baseUrl).toBe("https://api.openai.com/v1");
    expect(routes[0]?.cost).toBe("metered");
  });

  it("narrows a metered backend to self, and says why in words", () => {
    // The bug byollm_007 closes: a paid key offered publicly by accident.
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", { type: "openai", apiKeyEnv: "K", offer: "public" }),
      }),
    );
    expect(routes[0]?.offerScope).toBe("self");
    expect(problems[0]?.message).toContain("bills you per token");
    expect(problems[0]?.message).toContain("byollm offer");
  });

  it("refuses to share a metered backend without a ceiling", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", {
          type: "openai",
          apiKeyEnv: "K",
          offer: "public",
          spend: { acknowledged: true },
        }),
      }),
    );
    // Refused outright rather than given an unlimited ceiling.
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("dailyCapCents");
  });

  it("shares a metered backend once acknowledged with a ceiling", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", {
          type: "openai",
          apiKeyEnv: "K",
          offer: "named",
          spend: { acknowledged: true, dailyCapCents: 500 },
        }),
      }),
    );
    expect(problems).toEqual([]);
    expect(routes[0]?.offerScope).toBe("named");
    expect(routes[0]?.spendDailyCapCents).toBe(500);
  });

  it("cannot be told a remote endpoint is free [REMOTE_IS_NEVER_FREE]", () => {
    // Reaching a paid API through the generic backend must not escape the
    // metered rules. There is no `cost` field to set, and the base URL decides.
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("sneaky", {
          type: "openai-http",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "K",
          offer: "public",
        }),
      }),
    );
    expect(routes[0]?.cost).toBe("metered");
    expect(routes[0]?.offerScope).toBe("self");
    expect(problems[0]?.message).toContain("per token");
  });

  it("leaves a local generic backend free and shareable", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("local", {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "public",
        }),
      }),
    );
    expect(problems).toEqual([]);
    expect(routes[0]?.cost).toBe("free");
    expect(routes[0]?.offerScope).toBe("public");
  });

  it("refuses a config that tries to declare its own cost", () => {
    // COST_NOT_CONFIGURABLE: there is no such field, and `.strict()` means
    // inventing one is a parse failure rather than something ignored.
    expect(
      DaemonConfig.safeParse({
        ...only("gpt", { type: "openai", cost: "free" }),
      }).success,
    ).toBe(false);
  });

  it("still locks a subscription backend, consent or not", () => {
    const { routes } = resolveConfig(
      DaemonConfig.parse({
        ...only("claude", {
          type: "claude-cli",
          offer: "public",
          spend: { acknowledged: true, dailyCapCents: 10_000 },
        }),
      }),
    );
    expect(routes[0]?.offerScope).toBe("self");
  });
});
