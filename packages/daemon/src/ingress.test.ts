import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngressLog } from "./ingress.js";
import { removeTemp } from "./test-support.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-test-"));
});

afterEach(async () => {
  await removeTemp(dir);
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
        audience: "team",
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

  it("reduces a legacy `public` prompt a newer daemon can no longer write", async () => {
    /**
     * Written by hand, because `recordPrompt` will not accept the value any
     * more — `public` was removed as an offer scope and an audience on
     * 2026-08-26, and that is exactly the point. Lines this daemon can no
     * longer *write* it must still be able to *read*, and the stored
     * `audience` is `z.string()` so it can.
     *
     * If retention listed the sharing scopes instead of excluding `private`,
     * every one of these rows would have become non-community the day the
     * enum shrank, and somebody else's prompts would sit on this disk for
     * ever. The rule is not-private, so an audience this version does not
     * recognise is retained less, never more.
     */
    const path = join(dir, "legacy.log");
    const now = 100 * 86_400_000;
    await writeFile(
      path,
      `${JSON.stringify({
        type: "prompt",
        at: now - 30 * 86_400_000,
        origin: "https://app.test",
        jobId: "job_legacy",
        kind: "llm.generate",
        audience: "public",
        owner: "stranger",
        backendId: "openai-http",
        backendClass: "http",
        model: "m",
        promptHash: "a".repeat(64),
        promptChars: 4,
        prompt: "text",
      })}\n`,
    );

    const log = new IngressLog(options(path));
    expect(await log.applyRetention(now)).toBe(1);
    const [entry] = await log.read();
    expect(entry?.type === "prompt" && entry.prompt).toBeUndefined();
    // Still readable, still counted — the record that it ran never goes.
    expect(entry?.type === "prompt" && entry.promptHash).toHaveLength(64);
  });

  it("is idempotent — a second retention pass changes nothing", async () => {
    const log = new IngressLog(options(join(dir, "i.log")));
    const now = 100 * 86_400_000;
    await log.recordPrompt({
      at: now - 8 * 86_400_000,
      origin: "https://app.test",
      jobId: "job_old",
      kind: "llm.generate",
      audience: "team",
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
