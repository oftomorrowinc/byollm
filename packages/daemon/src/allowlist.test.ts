import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist, normalizeOrigin } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { IngressLog } from "./ingress.js";
import { removeTemp } from "./test-support.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-test-"));
});

afterEach(async () => {
  await removeTemp(dir);
});

describe("normalizeOrigin", () => {
  it("treats a trailing slash and a path as the same server", () => {
    expect(normalizeOrigin("https://app.test/")).toBe("https://app.test");
    expect(normalizeOrigin("https://app.test/api/byollm")).toBe(
      "https://app.test",
    );
  });

  it("keeps a non-default port, which is a different server", () => {
    expect(normalizeOrigin("http://app.test:3000")).toBe(
      "http://app.test:3000",
    );
    expect(normalizeOrigin("http://app.test:3000")).not.toBe(
      normalizeOrigin("http://app.test:4000"),
    );
  });
});

describe("Allowlist [NAMED_LOCAL_ALLOWLIST]", () => {
  it("admits nobody by default", async () => {
    const list = new Allowlist(join(dir, "allow.json"));
    await list.load();
    expect(list.list()).toEqual([]);
    expect(list.admits("https://app.test", "alice")).toBe(false);
  });

  it("admits only the exact (origin, owner) pair", async () => {
    const list = new Allowlist(join(dir, "allow.json"));
    await list.load();
    await list.add({ origin: "https://app.test", owner: "alice" }, Date.now());

    expect(list.admits("https://app.test", "alice")).toBe(true);
    // Same id, different app: a different person entirely.
    expect(list.admits("https://other.test", "alice")).toBe(false);
    expect(list.admits("https://app.test", "bob")).toBe(false);
  });

  it("matches regardless of how the origin was written", async () => {
    const list = new Allowlist(join(dir, "allow.json"));
    await list.load();
    await list.add({ origin: "https://app.test/", owner: "alice" }, Date.now());
    expect(list.admits("https://app.test/api/byollm", "alice")).toBe(true);
  });

  it("persists across reloads", async () => {
    const path = join(dir, "allow.json");
    const first = new Allowlist(path);
    await first.load();
    await first.add({ origin: "https://app.test", owner: "alice" }, Date.now());

    const second = new Allowlist(path);
    await second.load();
    expect(second.admits("https://app.test", "alice")).toBe(true);
  });

  it("does not duplicate an entry added twice", async () => {
    const list = new Allowlist(join(dir, "allow.json"));
    await list.load();
    await list.add({ origin: "https://app.test", owner: "alice" }, 1);
    await list.add({ origin: "https://app.test", owner: "alice" }, 2);
    expect(list.list()).toHaveLength(1);
  });

  it("removes an entry", async () => {
    const list = new Allowlist(join(dir, "allow.json"));
    await list.load();
    await list.add({ origin: "https://app.test", owner: "alice" }, Date.now());
    expect(await list.remove("https://app.test", "alice")).toBe(true);
    expect(list.admits("https://app.test", "alice")).toBe(false);
    expect(await list.remove("https://app.test", "alice")).toBe(false);
  });

  it("fails closed on a corrupt file", async () => {
    const path = join(dir, "allow.json");
    await writeFile(path, "{ this is not json");
    const list = new Allowlist(path);
    await list.load();
    // Refusing community work is the safe direction, and the owner sees an
    // empty list rather than a crash.
    expect(list.list()).toEqual([]);
  });

  it("refuses to be used before load", () => {
    const list = new Allowlist(join(dir, "allow.json"));
    expect(() => list.admits("https://app.test", "alice")).toThrow(
      /before load/,
    );
  });
});

describe("Budgets [COMMUNITY_BUDGETS]", () => {
  const limits = {
    maxJobsPerHour: 2,
    maxJobsPerDay: 3,
    maxWallClockMs: 1_000,
    maxOutputBytes: 1_000,
    maxPayloadChars: 100,
  };

  it("allows work under the caps", async () => {
    const budgets = new Budgets(join(dir, "b.json"), limits);
    await budgets.load(1_000);
    expect(budgets.check(1_000, 10).ok).toBe(true);
  });

  it("refuses past the hourly cap and recovers after the window", async () => {
    const budgets = new Budgets(join(dir, "b.json"), limits);
    const t0 = 10_000_000;
    await budgets.load(t0);
    await budgets.record(t0);
    await budgets.record(t0 + 1);

    const blocked = budgets.check(t0 + 2, 10);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusal).toBe("hourly-cap");

    // An hour later the window has moved on.
    expect(budgets.check(t0 + 3_600_001, 10).ok).toBe(true);
  });

  it("refuses past the daily cap", async () => {
    const budgets = new Budgets(join(dir, "b.json"), limits);
    const t0 = 10_000_000;
    await budgets.load(t0);
    await budgets.record(t0);
    await budgets.record(t0 + 1);
    await budgets.record(t0 + 3_600_002);

    const blocked = budgets.check(t0 + 3_600_003, 10);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusal).toBe("daily-cap");
  });

  it("refuses an oversized community payload", async () => {
    const budgets = new Budgets(join(dir, "b.json"), limits);
    await budgets.load(1_000);
    const blocked = budgets.check(1_000, 101);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.refusal).toBe("payload-too-large");
  });

  it("persists counts across restarts", async () => {
    const path = join(dir, "b.json");
    const t0 = 10_000_000;
    const first = new Budgets(path, limits);
    await first.load(t0);
    await first.record(t0);
    await first.record(t0 + 1);

    const second = new Budgets(path, limits);
    await second.load(t0 + 2);
    // Restarting the daemon must not reset someone else's quota.
    expect(second.check(t0 + 2, 10).ok).toBe(false);
  });
});

describe("IngressLog [INGRESS_LOGGED_BEFORE_EXECUTION]", () => {
  const options = (path: string) => ({
    path,
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  it("records a prompt with its hash and text", async () => {
    const log = new IngressLog(options(join(dir, "i.log")));
    await log.recordPrompt({
      at: 1_000,
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "private",
      owner: "alice",
      backendId: "openai-http",
      backendClass: "http",
      model: "gemma4:26b",
      prompt: "summarise this",
    });

    const [entry] = await log.read();
    expect(entry).toMatchObject({
      type: "prompt",
      prompt: "summarise this",
      promptChars: 14,
    });
  });

  it("escapes control characters so a prompt cannot forge a log line", async () => {
    const path = join(dir, "i.log");
    const log = new IngressLog(options(path));
    // A payload that contains a newline plus a plausible JSON object would,
    // in a naive log, appear as a second entry.
    const hostile = `x\n{"type":"prompt","jobId":"forged"}`;
    await log.recordPrompt({
      at: 1_000,
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "private",
      owner: "alice",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: hostile,
    });

    const entries = await log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ prompt: hostile, jobId: "job_1" });
  });

  it("can omit the owner's own prompt text when they ask", async () => {
    const log = new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 7,
      keepSelfPrompts: false,
    });
    await log.recordPrompt({
      at: 1_000,
      origin: "https://app.test",
      jobId: "job_1",
      kind: "llm.generate",
      audience: "private",
      owner: "alice",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: "private",
    });

    const [entry] = await log.read();
    expect(entry?.type).toBe("prompt");
    if (entry?.type === "prompt") {
      expect(entry.prompt).toBeUndefined();
      // The hash and the size survive, so the record is still honest.
      expect(entry.promptHash).toHaveLength(64);
      expect(entry.promptChars).toBe(7);
    }
  });

  it("reduces old community prompts to their hash but keeps recent ones", async () => {
    const log = new IngressLog(options(join(dir, "i.log")));
    const now = 100 * 86_400_000;
    const old = now - 8 * 86_400_000;

    for (const [at, jobId] of [
      [old, "job_old"],
      [now, "job_new"],
    ] as const) {
      await log.recordPrompt({
        at,
        origin: "https://app.test",
        jobId,
        kind: "llm.generate",
        audience: "public",
        owner: "stranger",
        backendId: "openai-http",
        backendClass: "http",
        model: "m",
        prompt: `text for ${jobId}`,
      });
    }

    expect(await log.applyRetention(now)).toBe(1);

    const entries = await log.read();
    const byId = new Map(
      entries
        .filter((e) => e.type === "prompt")
        .map((e) => [e.jobId, e] as const),
    );
    expect(byId.get("job_old")?.prompt).toBeUndefined();
    expect(byId.get("job_new")?.prompt).toBe("text for job_new");
    // The record of *that it ran* is never removed.
    expect(byId.get("job_old")?.promptHash).toHaveLength(64);
  });

  it("never reduces the owner's own prompts", async () => {
    const log = new IngressLog(options(join(dir, "i.log")));
    const now = 500 * 86_400_000;
    await log.recordPrompt({
      at: now - 400 * 86_400_000,
      origin: "https://app.test",
      jobId: "job_mine",
      kind: "llm.generate",
      audience: "private",
      owner: "alice",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: "my old prompt",
    });

    expect(await log.applyRetention(now)).toBe(0);
    const [entry] = await log.read();
    expect(entry?.type === "prompt" && entry.prompt).toBe("my old prompt");
  });

  it("is idempotent — a second retention pass changes nothing", async () => {
    const log = new IngressLog(options(join(dir, "i.log")));
    const now = 100 * 86_400_000;
    await log.recordPrompt({
      at: now - 8 * 86_400_000,
      origin: "https://app.test",
      jobId: "job_old",
      kind: "llm.generate",
      audience: "public",
      owner: "stranger",
      backendId: "openai-http",
      backendClass: "http",
      model: "m",
      prompt: "text",
    });
    expect(await log.applyRetention(now)).toBe(1);
    expect(await log.applyRetention(now)).toBe(0);
  });

  it("skips a truncated final line after a hard kill", async () => {
    const path = join(dir, "i.log");
    const log = new IngressLog(options(path));
    await log.recordOutcome({
      at: 1_000,
      jobId: "job_1",
      outcome: "ok",
      durationMs: 5,
      outputChars: 3,
    });
    await writeFile(path, '{"type":"outcome","at":1000,', { flag: "a" });
    expect(await log.read()).toHaveLength(1);
  });
});

describe("the local veto — Amendment G, property 3", () => {
  it("refuses somebody who was never on the allowlist", async () => {
    // The case it exists for: a roster member this device has no local row
    // for at all. A veto that needed an entry to remove would be useless
    // exactly where it matters.
    const list = new Allowlist(join(dir, "veto.json"));
    await list.load();
    expect(list.vetoes("https://app.test", "carol")).toBe(false);
    await list.veto({ origin: "https://app.test", owner: "carol" }, 1);
    expect(list.vetoes("https://app.test", "carol")).toBe(true);
  });

  it("is keyed by origin as well as owner", async () => {
    // Owner ids are server-namespace-local: `carol` on one app is not `carol`
    // on another, and a veto keyed by id alone would refuse a stranger.
    const list = new Allowlist(join(dir, "veto2.json"));
    await list.load();
    await list.veto({ origin: "https://a.test", owner: "carol" }, 1);
    expect(list.vetoes("https://b.test", "carol")).toBe(false);
  });

  it("is idempotent — refusing twice is refusing once", async () => {
    const list = new Allowlist(join(dir, "veto3.json"));
    await list.load();
    await list.veto({ origin: "https://app.test", owner: "carol" }, 1);
    await list.veto({ origin: "https://app.test", owner: "carol" }, 2);
    expect(list.vetoed()).toHaveLength(1);
  });

  it("lifts, which restores the roster's answer rather than granting one", async () => {
    const list = new Allowlist(join(dir, "veto4.json"));
    await list.load();
    await list.veto({ origin: "https://app.test", owner: "carol" }, 1);
    expect(await list.unveto("https://app.test", "carol")).toBe(true);
    expect(list.vetoes("https://app.test", "carol")).toBe(false);
    // Lifting a veto nobody set changes nothing and says so.
    expect(await list.unveto("https://app.test", "nobody")).toBe(false);
  });

  it("survives a reload, and an old file reads as no vetoes", async () => {
    const path = join(dir, "veto5.json");
    const first = new Allowlist(path);
    await first.load();
    await first.veto({ origin: "https://app.test", owner: "carol" }, 1);

    const second = new Allowlist(path);
    await second.load();
    expect(second.vetoes("https://app.test", "carol")).toBe(true);

    // A file written before vetoes existed has none — which is the truthful
    // reading of its absence: this device has refused nobody.
    const legacy = join(dir, "legacy.json");
    await writeFile(
      legacy,
      JSON.stringify({ version: 1, entries: [] }),
      "utf8",
    );
    const third = new Allowlist(legacy);
    await third.load();
    expect(third.vetoed()).toEqual([]);
  });
});
