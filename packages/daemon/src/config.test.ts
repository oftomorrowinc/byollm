import { describe, expect, it } from "vitest";
import { DaemonConfig, resolveConfig } from "./config.js";

const base = {
  backends: {
    local: { backend: "openai-http", baseUrl: "http://127.0.0.1:11434/v1" },
  },
  routes: { "llm.generate": { backend: "local", model: "gemma4:26b" } },
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

  it("defaults a backend's offer scope to self", () => {
    expect(parse().backends["local"]?.offer).toBe("self");
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // A typo'd config key that is silently dropped is a setting the owner
    // believes is in force and is not.
    expect(DaemonConfig.safeParse({ ...base, concurency: 8 }).success).toBe(
      false,
    );
  });

  it("refuses an unregistered backend id", () => {
    expect(
      DaemonConfig.safeParse({
        backends: { x: { backend: "curl-whatever" } },
        routes: {},
      }).success,
    ).toBe(false);
  });
});

describe("resolveConfig — the subscription self-lock [SUBSCRIPTION_SELF_LOCK]", () => {
  it("ignores a widened offer on a subscription backend and says so", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        backends: { claude: { backend: "claude-cli", offer: "public" } },
        routes: {
          "llm.generate": { backend: "claude", model: "claude-opus-5" },
        },
      }),
    );
    expect(routes[0]?.offerScope).toBe("self");
    expect(problems[0]?.message).toContain("locked to your work only");
  });

  it("honours a widened offer on an open backend", () => {
    const { routes } = resolveConfig(
      DaemonConfig.parse({
        backends: {
          local: {
            backend: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
            offer: "public",
          },
        },
        routes: { "llm.generate": { backend: "local", model: "gemma4:26b" } },
      }),
    );
    expect(routes[0]?.offerScope).toBe("public");
  });
});

describe("resolveConfig — a broken route is dropped, not fatal", () => {
  it("drops a route whose backend is not defined", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        backends: {},
        routes: { "llm.generate": { backend: "ghost", model: "m" } },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("not defined");
  });

  it("drops an HTTP backend with no baseUrl", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        backends: { local: { backend: "openai-http" } },
        routes: { "llm.generate": { backend: "local", model: "m" } },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("baseUrl");
  });

  it("drops an HTTP backend pointed at a metadata endpoint", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        backends: {
          local: {
            backend: "openai-http",
            baseUrl: "http://169.254.169.254/v1",
          },
        },
        routes: { "llm.generate": { backend: "local", model: "m" } },
      }),
    );
    expect(routes).toHaveLength(0);
    expect(problems[0]?.message).toContain("metadata");
  });

  it("keeps the good routes when one is broken", () => {
    const { routes, problems } = resolveConfig(
      DaemonConfig.parse({
        backends: {
          local: {
            backend: "openai-http",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
        routes: {
          "llm.generate": { backend: "local", model: "gemma4:26b" },
          "llm.chat": { backend: "ghost", model: "m" },
        },
      }),
    );
    expect(routes.map((r) => r.kind)).toEqual(["llm.generate"]);
    expect(problems).toHaveLength(1);
  });
});
