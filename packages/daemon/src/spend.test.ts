import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger, estimateCents } from "./spend.js";
import { removeTemp } from "./test-support.js";

let dir: string;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-spend-"));
});
afterEach(async () => {
  await removeTemp(dir);
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

  it("does not throw on a corrupt ledger, and does not believe it either", async () => {
    /* Flipped, 2026-09-03. This asserted `spentTodayCents === 0` and called
       that the desired behaviour. Zero is what the counter says when the
       file is gone *and* when the file is unreadable, and the second one is
       not a measurement — see the ceiling assertions below, which are what
       this file should have been checking all along. */
    const path = join(dir, "spend.json");
    await writeFile(path, "{ not json");
    const l = new SpendLedger(path);
    await l.load(NOW);
    expect(l.untrustedReason()).toMatch(/not valid JSON/);
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
  it("brakes a configured cap, which is the case that was open", async () => {
    /*
     * The test that blessed the bug, rewritten to expose it.
     *
     * It used to assert the undefined-cap case and stop there — and that case
     * was closed for its own separate reason, so the assertion passed while
     * the gate it appeared to be guarding stood open. With a cap configured,
     * an empty ledger reads `0 >= cap` as false and metered community work is
     * admitted on a ledger nobody could read. **The prover aged with the
     * wrong contract.**
     */
    await writeFile(join(dir, "spend.json"), "{ this is not json");
    const l = ledger();
    await l.load(NOW);

    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
    // And the case that was always closed, so a regression can be told apart
    // from this one.
    expect(l.hasReachedCeiling("gpt", undefined, NOW)).toBe(true);
  });

  it("brakes on an unreadable ledger, not merely an unparseable one", async () => {
    /* A directory where the file should be: the read fails with EISDIR
       rather than returning bytes that will not parse. Same verdict — the
       disk declining to say what it holds is not the disk holding nothing. */
    const l = new SpendLedger(join(dir, "as-a-directory"));
    await mkdir(join(dir, "as-a-directory"), { recursive: true });
    await l.load(NOW);

    expect(l.untrustedReason()).toBeDefined();
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
  });

  it("counts a fresh machine as fresh, not as broken", async () => {
    /* The control that keeps the brake honest. A ledger that has never been
       written must not brake anything, or every new device refuses community
       work forever and the fix reads as "sharing is broken". */
    const l = new SpendLedger(join(dir, "never-written.json"));
    await l.load(NOW);

    expect(l.untrustedReason()).toBeUndefined();
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(false);
  });

  it("will not overwrite a ledger it could not read", async () => {
    // The latch. Recording here would replace the evidence with a file
    // holding one entry, and call that entry the whole day's spending.
    const path = join(dir, "spend.json");
    await writeFile(path, "{ this is not json");
    const l = new SpendLedger(path);
    await l.load(NOW);
    await l.record("gpt", 42, NOW);

    expect(await readFile(path, "utf8")).toBe("{ this is not json");
    expect(l.hasReachedCeiling("gpt", 100, NOW)).toBe(true);
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
