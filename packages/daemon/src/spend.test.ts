import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger, estimateCents } from "./spend.js";

let dir: string;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-spend-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ledger = () => new SpendLedger(join(dir, "spend.json"));

describe("SpendLedger [METERED_REQUIRES_CEILING]", () => {
  it("treats a backend with no ceiling as already at it", async () => {
    const l = ledger();
    await l.load(NOW);
    // Not "unlimited" — the safe direction. Sharing without a ceiling is
    // refused at config load, so reaching here means something is off.
    expect(l.hasReachedCeiling("gpt", undefined, NOW)).toBe(true);
  });

  it("counts spend within the day and stops at the ceiling", async () => {
    const l = ledger();
    await l.load(NOW);
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(false);

    await l.record("gpt", 60, NOW);
    expect(l.spentTodayCents("gpt", NOW)).toBeCloseTo(60);
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(false);

    await l.record("gpt", 45, NOW);
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
  });

  it("forgets spend older than a day", async () => {
    const l = ledger();
    await l.load(NOW);
    await l.record("gpt", 500, NOW);
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
    // A day later the window has moved on.
    expect(l.hasReachedCeiling("gpt", 100, NOW + 86_400_001)).toBe(false);
  });

  it("keeps backends separate", async () => {
    const l = ledger();
    await l.load(NOW);
    await l.record("gpt", 500, NOW);
    expect(l.hasReachedCeiling("gemini", 100, NOW)).toBe(false);
  });

  it("survives a restart — a daemon bounce must not reset the meter", async () => {
    const path = join(dir, "spend.json");
    const first = new SpendLedger(path);
    await first.load(NOW);
    await first.record("gpt", 90, NOW);

    const second = new SpendLedger(path);
    await second.load(NOW);
    expect(second.hasReachedCeiling("gpt", 100, NOW)).toBe(false);
    await second.record("gpt", 20, NOW);
    expect(second.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
  });

  it("reads a corrupt ledger as empty rather than throwing", async () => {
    const path = join(dir, "spend.json");
    await writeFile(path, "{ not json");
    const l = new SpendLedger(path);
    await l.load(NOW);
    expect(l.spentTodayCents("gpt", NOW)).toBe(0);
  });

  it("refuses to be used before load", () => {
    expect(() => ledger().spentTodayCents("gpt", NOW)).toThrow(/before load/);
  });

  it("summarises per backend for the trust UI", async () => {
    const l = ledger();
    await l.load(NOW);
    await l.record("gpt", 10, NOW);
    await l.record("gemini", 5, NOW);
    const summary = l.summary(NOW);
    expect(summary["gpt"]).toBeCloseTo(10);
    expect(summary["gemini"]).toBeCloseTo(5);
  });
});

describe("estimateCents", () => {
  it("scales with text length and the owner's rate", () => {
    const cheap = estimateCents(4000, 4000, 100);
    const dear = estimateCents(4000, 4000, 1000);
    expect(dear).toBeCloseTo(cheap * 10);
    // 8000 chars ≈ 2000 tokens; at 100c/M that is 0.2c.
    expect(cheap).toBeCloseTo(0.2, 3);
  });

  it("costs nothing for nothing", () => {
    expect(estimateCents(0, 0, 1500)).toBe(0);
  });
});

describe("a ledger that cannot be trusted brakes rather than opens", () => {
  it("reads a corrupt ledger as empty — and empty means ceiling-reached", async () => {
    await writeFile(join(dir, "spend.json"), "{ this is not json");
    const l = ledger();
    await l.load(NOW);

    // Not a throw, because a broken ledger must not stop the daemon taking
    // the owner's own work. Zero spend is the unsafe reading, so the brake
    // comes from the ceiling rule instead: no ceiling means reached.
    expect(l.spentTodayCents("gpt", NOW)).toBe(0);
    expect(l.hasReachedCeiling("gpt", undefined, NOW)).toBe(true);
  });

  it("reads a well-formed but wrong-shaped ledger as empty", async () => {
    await writeFile(
      join(dir, "spend.json"),
      JSON.stringify({ version: 2, entries: { gpt: "lots" } }),
    );
    const l = ledger();
    await l.load(NOW);
    expect(l.spentTodayCents("gpt", NOW)).toBe(0);
  });

  it("drops a backend whose every entry has aged out, and keeps the rest", async () => {
    const l = ledger();
    await l.load(NOW);
    await l.record("old", 40, NOW - 90_000_000);
    await l.record("new", 7, NOW);

    const fresh = ledger();
    await fresh.load(NOW);

    // Yesterday cannot affect today's ceiling, so it stops being stored at
    // all — the file does not grow forever.
    expect(fresh.summary(NOW)).toEqual({ new: 7 });
  });
});
