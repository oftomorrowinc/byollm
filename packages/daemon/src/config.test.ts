import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonConfig, loadConfig, resolveConfig } from "./config.js";

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

  it("defaults a service's offer scope to private", () => {
    expect(parse().services["local"]?.offer).toBe("private");
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
            offer: "team",
          },
        },
      }),
    );
    expect(routes[0]?.offerScope).toBe("private");
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
            offer: "team",
          },
        },
      }),
    );
    expect(routes[0]?.offerScope).toBe("team");
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
    // Both are selectable; neither is the default — byollm_016 Phase B, and a
    // deliberate change of meaning from Phase A, where this produced no routes
    // at all.
    //
    // Withheld is a fact about the *kind*, not about the services. A job that
    // names one of these by name is not ambiguous and never was; what has no
    // answer is a job that named nothing, and that is exactly what the absent
    // `isDefault` denies it. Refusing the named case too would punish a site
    // for a decision its owner had not made about something else.
    expect(routes.map((r) => r.service).sort()).toEqual(["llama", "qwen"]);
    expect(routes.some((r) => r.isDefault)).toBe(false);
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
    // Both stay on the menu; the default decides only where an unselected job
    // goes. Naming one is what `defaults` is for, not narrowing what exists.
    expect(routes.map((r) => r.service).sort()).toEqual(["llama", "qwen"]);
    const chosen = routes.filter((r) => r.isDefault);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.service).toBe("qwen");
    expect(chosen[0]?.model).toBe("qwen3");
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
    // The services are still selectable — they are declared and healthy, and
    // the owner's mistake is about which one wins, not about whether they
    // exist. What nothing gets is a default, so an unselected job has no
    // answer here and the problem says why.
    expect(routes.map((r) => r.service).sort()).toEqual(["llama", "qwen"]);
    expect(routes.some((r) => r.isDefault)).toBe(false);
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
    // The bug byollm_007 closes: a paid key shared by accident.
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", { type: "openai", apiKeyEnv: "K", offer: "team" }),
      }),
    );
    expect(routes[0]?.offerScope).toBe("private");
    expect(problems[0]?.message).toContain("bills you per token");
    expect(problems[0]?.message).toContain("byollm offer");
  });

  it("refuses to share a metered backend without a ceiling", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("gpt", {
          type: "openai",
          apiKeyEnv: "K",
          offer: "team",
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
          offer: "team",
          spend: { acknowledged: true, dailyCapCents: 500 },
        }),
      }),
    );
    expect(problems).toEqual([]);
    expect(routes[0]?.offerScope).toBe("team");
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
          offer: "team",
        }),
      }),
    );
    expect(routes[0]?.cost).toBe("metered");
    expect(routes[0]?.offerScope).toBe("private");
    expect(problems[0]?.message).toContain("per token");
  });

  it("leaves a local generic backend free and shareable", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        ...only("local", {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "team",
        }),
      }),
    );
    expect(problems).toEqual([]);
    expect(routes[0]?.cost).toBe("free");
    expect(routes[0]?.offerScope).toBe("team");
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
          offer: "team",
          spend: { acknowledged: true, dailyCapCents: 10_000 },
        }),
      }),
    );
    expect(routes[0]?.offerScope).toBe("private");
  });
});

describe("the pre-alpha.44 shape", () => {
  async function write(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "byollm-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(config), "utf8");
    return path;
  }

  it("names what changed instead of emitting a schema error", async () => {
    // An upgrade is the moment the owner is least equipped to read a zod
    // issue list. The refusal has to say which shape it found and what
    // replaced it, or the config that ran yesterday just stops with
    // "unrecognized keys" and the owner has nowhere to go.
    const path = await write({
      backends: {
        ollama: {
          backend: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
      routes: { "llm.generate": { backend: "ollama", model: "llama3.2" } },
    });
    await expect(loadConfig(path)).rejects.toThrow(
      /pre-alpha\.44 config shape \(`backends` and `routes`\)/,
    );
    await expect(loadConfig(path)).rejects.toThrow(/one `services` map/);
  });

  it("names only the half that is present", async () => {
    const path = await write({
      routes: { "llm.generate": { backend: "ollama" } },
    });
    await expect(loadConfig(path)).rejects.toThrow(/shape \(`routes`\)/);
  });

  it("leaves a current config alone", async () => {
    const path = await write({
      services: {
        ollama: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "llama3.2",
          kinds: ["llm.generate"],
        },
      },
    });
    const { routes } = await loadConfig(path);
    expect(routes.map((route) => route.service)).toEqual(["ollama"]);
  });
});

describe("the menu travels — byollm_016 Phase B", () => {
  const twoForOneKind = DaemonConfig.parse({
    services: {
      studio: {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen",
        kinds: ["llm.generate"],
      },
      spare: {
        type: "openai-http",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "mistral",
        kinds: ["llm.generate"],
      },
    },
    defaults: { "llm.generate": "studio" },
  });

  it("advertises the service a job might name, not only the winner", () => {
    // The bug this replaces: only the default was a route, so it was the only
    // thing in the advertised matrix, so it was the only name the hub could
    // match a selection against. Selecting `spare` was refused as
    // unadvertised — selection worked for exactly the service nobody needs to
    // name, and for nothing else.
    const { routes } = resolveConfig(twoForOneKind);
    expect(routes.map((r) => r.service).sort()).toEqual(["spare", "studio"]);
  });

  it("marks exactly one of them as the default", () => {
    const { routes } = resolveConfig(twoForOneKind);
    expect(routes.filter((r) => r.isDefault).map((r) => r.service)).toEqual([
      "studio",
    ]);
  });

  it("marks none when the owner has not chosen", () => {
    // Withheld is a fact about the kind. Both remain selectable by name; what
    // has no answer is a job that named nothing.
    const { routes, withheld } = resolveConfig(
      DaemonConfig.parse({
        services: {
          studio: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "qwen",
            kinds: ["llm.generate"],
          },
          spare: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "mistral",
            kinds: ["llm.generate"],
          },
        },
      }),
    );
    expect(routes).toHaveLength(2);
    expect(routes.some((r) => r.isDefault)).toBe(false);
    expect(withheld.map((w) => w.kind)).toEqual(["llm.generate"]);
  });
});
