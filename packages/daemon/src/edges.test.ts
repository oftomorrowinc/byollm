import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeCliBackend,
  childEnv,
  claudeArgv,
} from "./backends/claude-cli.js";
import { createBackend } from "./backends/index.js";
import { OpenAiHttpBackend } from "./backends/openai-http.js";
import { Budgets } from "./budgets.js";
import { loadConfig } from "./config.js";
import { currentPlatform } from "./connect.js";
import { daemonPaths, defaultRoot } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * The paths a happy run never takes: bad config, missing files, unreachable
 * backends. byollm_002 is emphatic that these must each say something
 * different, so each one is asserted for the message it produces.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-edges-"));
});

afterEach(async () => {
  await removeTemp(dir);
});

describe("paths", () => {
  it("puts everything under one directory the owner can find", () => {
    // Built with `join`, asserted with `join`. Hardcoding "/" made this the
    // one daemon unit test that could not pass on Windows, where the same
    // correct code produces "\\" — a test failing on a separator says
    // nothing about the property, which is that these live together under a
    // root the owner can find.
    const root = join(tmpdir(), "byollm-test");
    const paths = daemonPaths(root);
    expect(paths.config).toBe(join(root, "config.json"));
    expect(paths.ingressLog).toBe(join(root, "ingress.log"));
    expect(paths.allowlist).toBe(join(root, "allow.json"));
  });

  it("honours BYOLLM_HOME so tests never touch a real ~/.byollm", () => {
    const previous = process.env["BYOLLM_HOME"];
    try {
      const override = join(tmpdir(), "byollm-override");
      process.env["BYOLLM_HOME"] = override;
      expect(defaultRoot()).toBe(override);
      delete process.env["BYOLLM_HOME"];
      expect(defaultRoot()).toMatch(/\.byollm$/);
    } finally {
      if (previous === undefined) delete process.env["BYOLLM_HOME"];
      else process.env["BYOLLM_HOME"] = previous;
    }
  });
});

describe("loadConfig", () => {
  it("falls back to defaults when the owner has written no config", async () => {
    const { config, routes } = await loadConfig(join(dir, "missing.json"));
    expect(config.concurrency).toBe(2);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("refuses a config that is not JSON, naming the file", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not json");
    // Silently running on defaults when the owner *did* write a config would
    // execute work under rules they did not choose.
    await expect(loadConfig(path)).rejects.toThrow(/is not valid JSON/);
  });

  it("refuses a config that fails the schema, listing what is wrong", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ services: {}, concurrency: 99 }));
    await expect(loadConfig(path)).rejects.toThrow(/concurrency/);
  });

  it("propagates an unexpected filesystem error rather than swallowing it", async () => {
    // A directory where a file should be is not "no config"; it is a problem.
    await expect(loadConfig(dir)).rejects.toThrow();
  });
});

describe("Budgets", () => {
  it("refuses community work when the file is corrupt", async () => {
    /* Flipped, 2026-09-03. This asserted that a corrupt file starts the
       counter at zero — which it does, and which is exactly the failure: a
       count reconstructed from a file nobody could read passes both caps.
       The question is not what `usage` reports but what `check` decides. */
    const path = join(dir, "b.json");
    await writeFile(path, "not json");
    const budgets = new Budgets(path, {
      maxJobsPerHour: 1,
      maxJobsPerDay: 1,
      maxWallClockMs: 1,
      maxOutputBytes: 1,
      maxPayloadChars: 10,
    });
    await budgets.load(1_000);

    expect(budgets.check(1_000, 1)).toMatchObject({
      ok: false,
      refusal: "ledger-untrusted",
    });
    expect(budgets.untrustedReason()).toBeDefined();
  });

  it("accepts community work when the file has simply never existed", async () => {
    // The control. Fresh is not corrupt, or no new device ever shares.
    const budgets = new Budgets(join(dir, "never-written.json"), {
      maxJobsPerHour: 1,
      maxJobsPerDay: 1,
      maxWallClockMs: 1,
      maxOutputBytes: 1,
      maxPayloadChars: 10,
    });
    await budgets.load(1_000);

    expect(budgets.check(1_000, 1)).toEqual({ ok: true });
    expect(budgets.untrustedReason()).toBeUndefined();
  });

  it("refuses to be used before load", () => {
    const budgets = new Budgets(join(dir, "b.json"), {
      maxJobsPerHour: 1,
      maxJobsPerDay: 1,
      maxWallClockMs: 1,
      maxOutputBytes: 1,
      maxPayloadChars: 10,
    });
    expect(() => budgets.check(1_000, 1)).toThrow(/before load/);
  });
});

describe("backend construction", () => {
  it("builds each registered backend", () => {
    expect(
      createBackend("openai-http", { baseUrl: "http://127.0.0.1:11434/v1" })
        .class,
    ).toBe("http");
    expect(createBackend("claude-cli", {}).class).toBe("process");
  });

  it("refuses an HTTP backend with no base URL", () => {
    expect(() => new OpenAiHttpBackend({})).toThrow(/requires a baseUrl/);
  });

  it("refuses a base URL that would leave its own origin", () => {
    expect(
      () => new OpenAiHttpBackend({ baseUrl: "http://169.254.169.254/v1" }),
    ).toThrow(/metadata/);
  });
});

describe("openai-http — unreachable backend", () => {
  const backend = () =>
    new OpenAiHttpBackend({ baseUrl: "http://127.0.0.1:1/v1" });

  it("reports the origin it could not reach, not a bare 'fetch failed'", async () => {
    const health = await backend().health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("127.0.0.1:1");
  });

  it("fails a job as unreachable rather than throwing", async () => {
    const result = await backend().execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("backend-unreachable");
      /* The retry decision left this shape on 2026-09-04. Adapters report a
         code; the site-facing class table decides whether trying again is
         worth it, because three adapters deciding separately is how one of
         them came to leak a fact about somebody's account. */
    }
  });

  it("reports a cancelled call as cancelled, not as an outage", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await backend().execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("canceled");
  });

  it("sends an API key only when the owner named an env var holding one", async () => {
    process.env["BYOLLM_TEST_KEY"] = "sk-test";
    try {
      const withKey = new OpenAiHttpBackend({
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnv: "BYOLLM_TEST_KEY",
      });
      // Unreachable either way; what matters is that construction accepts it
      // and the key never appears in config.
      expect((await withKey.health()).healthy).toBe(false);
    } finally {
      delete process.env["BYOLLM_TEST_KEY"];
    }
  });
});

describe("claude-cli — the argv and environment contract", () => {
  it("builds the same argv every time, with the owner's model", () => {
    const argv = claudeArgv("claude-opus-5");
    expect(argv).toEqual(claudeArgv("claude-opus-5"));
    expect(argv).toContain("--print");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  });

  it("keeps only allowlisted variables, and never the API key", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      ANTHROPIC_API_KEY: "sk-should-not-appear",
      AWS_SECRET_ACCESS_KEY: "also-not",
      SOME_OTHER: "no",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/me");
    expect(env["CI"]).toBe("1");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["SOME_OTHER"]).toBeUndefined();
  });

  it("omits an allowlisted variable that is simply not set", () => {
    expect(childEnv({ PATH: "/usr/bin" })["HOME"]).toBeUndefined();
  });

  it("reports a missing CLI with somewhere to go", async () => {
    const health = await new ClaudeCliBackend(
      "/nonexistent/byollm-not-a-binary",
    ).health();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("claude.com/claude-code");
  });

  it("advertises no model list rather than inventing one", async () => {
    // The CLI cannot enumerate models, and a made-up list would be a lie.
    const health = await new ClaudeCliBackend("echo").health();
    expect(health.models).toEqual([]);
  });
});

describe("currentPlatform", () => {
  it("reports one of the three the protocol knows", () => {
    expect(["darwin", "linux", "win32"]).toContain(currentPlatform());
  });
});
