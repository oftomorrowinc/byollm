import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_KINDS, type ClaimedJob, type JobKind } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { SERVED_KINDS, composePrompt, isServedKind } from "./compose.js";
import { DaemonConfig, loadConfig, resolveConfig } from "./config.js";

/**
 * A kind the protocol knows is not a kind this daemon serves — #7053.
 *
 * 0.1.5's card 1 widened `JobKind` before any handler existed, and the config
 * schema parses kinds with that enum. Owl ran this tree's build: a service
 * listing `llm.tools`, `llm.vision` or `llm.image` resolved to a route with
 * zero problems, and `composePrompt` then ran it as chat. These cases are the
 * reverse of that run.
 */

/**
 * Named, not derived: a test per new kind, as the review asked. `llm.tools`
 * left this list in card 3 of #6933 (#7055), with its loop.
 */
const UNSERVED = ["llm.vision", "llm.image"] as const;

const service = (kinds: readonly string[]) => ({
  services: {
    local: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "gemma4:26b",
      kinds,
    },
  },
});

describe("the daemon's one list of served kinds", () => {
  it("is generate, chat and tools in this build", () => {
    expect([...SERVED_KINDS]).toEqual([
      "llm.generate",
      "llm.chat",
      "llm.tools",
    ]);
  });

  it("leaves exactly the named kinds unserved, so a new protocol kind lands here", () => {
    // A kind added to the protocol without a handler shows up as a failure
    // here rather than as a silent route somewhere else.
    expect(JOB_KINDS.filter((kind) => !isServedKind(kind))).toEqual([
      ...UNSERVED,
    ]);
  });
});

describe.each(UNSERVED)("a service listing %s", (kind) => {
  it("parses — a config written for a newer byollm still starts this one", () => {
    expect(DaemonConfig.safeParse(service([kind])).success).toBe(true);
  });

  it("gets no route, and a problem that names the kind", () => {
    const loaded = resolveConfig(DaemonConfig.parse(service([kind])));
    expect(loaded.routes).toEqual([]);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.where).toBe("services.local.kinds");
    expect(loaded.problems[0]?.message).toContain(kind);
    expect(loaded.problems[0]?.message).toContain("not served by this build");
  });

  it("does not cost the service the kinds it does serve", () => {
    const loaded = resolveConfig(
      DaemonConfig.parse(service(["llm.chat", kind])),
    );
    expect(loaded.routes.map((route) => route.kind)).toEqual(["llm.chat"]);
    expect(loaded.routes[0]?.isDefault).toBe(true);
    expect(loaded.problems).toHaveLength(1);
  });

  it("is not made ambiguous by a second service listing it", () => {
    // Withheld before claimants are counted: two services listing an
    // unserved kind must not also produce a "set defaults" problem for a
    // kind nothing here can run.
    const config = service([kind]);
    const loaded = resolveConfig(
      DaemonConfig.parse({
        services: { ...config.services, other: config.services.local },
      }),
    );
    expect(loaded.routes).toEqual([]);
    expect(loaded.withheld).toEqual([]);
    expect(loaded.problems.map((problem) => problem.where)).toEqual([
      "services.local.kinds",
      "services.other.kinds",
    ]);
  });

  it("gets no route through the real loader either", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-served-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(service(["llm.generate", kind])));
    const loaded = await loadConfig(path);
    expect(loaded.routes.map((route) => route.kind)).toEqual(["llm.generate"]);
    expect(loaded.problems.some((p) => p.message.includes(kind))).toBe(true);
  });

  it("is refused by composePrompt instead of being composed as chat", () => {
    const job = {
      kind,
      payload: { messages: [{ role: "user", content: "hi" }] },
    } as unknown as ClaimedJob;
    expect(() => composePrompt(job)).toThrow(
      `this daemon does not compose ${kind} jobs`,
    );
  });
});

describe("llm.tools is served on HTTP services only — byollm_012 §7", () => {
  it("gets a route on an HTTP service", () => {
    const loaded = resolveConfig(DaemonConfig.parse(service(["llm.tools"])));
    expect(loaded.routes.map((route) => route.kind)).toEqual(["llm.tools"]);
    expect(loaded.problems).toEqual([]);
  });

  it.each(["claude-cli", "codex-cli"])(
    "gets no route on %s, and a problem naming the fix",
    (type) => {
      const loaded = resolveConfig(
        DaemonConfig.parse({
          services: {
            cli: { type, model: "default", kinds: ["llm.chat", "llm.tools"] },
          },
        }),
      );
      expect(loaded.routes.map((route) => route.kind)).toEqual(["llm.chat"]);
      expect(loaded.problems).toHaveLength(1);
      expect(loaded.problems[0]?.where).toBe("services.cli.kinds");
      expect(loaded.problems[0]?.message).toContain("needs an HTTP service");
    },
  );
});

describe("composePrompt and the list agree", () => {
  const payloads: Record<(typeof SERVED_KINDS)[number], unknown> = {
    "llm.generate": { prompt: "hi" },
    "llm.chat": { messages: [{ role: "user", content: "hi" }] },
    "llm.tools": { messages: [{ role: "user", content: "hi" }] },
  };

  it.each([...SERVED_KINDS])("composes %s", (kind: JobKind) => {
    const job = {
      kind,
      payload: payloads[kind as (typeof SERVED_KINDS)[number]],
    } as unknown as ClaimedJob;
    expect(composePrompt(job)).toContain("hi");
  });
});
