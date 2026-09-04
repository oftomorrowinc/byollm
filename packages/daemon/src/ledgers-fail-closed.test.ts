import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOCK_SKEW_WARN_MS, GRANT_MAX_AGE_MS } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { writeLedger } from "./ledger.js";
import { SpendLedger } from "./spend.js";
import { SpentGrants } from "./spent-grants.js";
import { removeTemp } from "./test-support.js";

/**
 * The three ledgers, and the failure they shared — byollm_016, 2026-09-03.
 * Reported by Robertson Price (vibewrk).
 *
 * Each of these files caught every read failure into an empty container and
 * carried on. Empty is what a brand-new machine looks like, so each brake
 * read a file it could not parse as "nothing has happened yet" and opened.
 * No attacker is needed to produce that state: all three wrote to their live
 * path directly, so an interrupted write *manufactures* the input that takes
 * the recovery path on the next start. The bug and its trigger were the same
 * line.
 *
 * Here as one file because the fix is one pattern, and because the thing most
 * worth testing is the seam between them — what each brake covers, and what
 * it must leave alone.
 */
const NOW = 1_800_000_000_000;
const LIMITS = {
  maxJobsPerHour: 10,
  maxJobsPerDay: 100,
  maxWallClockMs: 1_000,
  maxOutputBytes: 1_000,
  maxPayloadChars: 1_000,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-ledgers-"));
});

afterEach(async () => {
  await removeTemp(dir);
});

describe("a torn write, a restart, and the same grant twice", () => {
  it("refuses the replay that a half-written ledger used to admit", async () => {
    /*
     * The reported attack, in order, with nothing forged.
     *
     * A grant is admitted and burned. The process dies mid-write — power,
     * OOM, a deploy — leaving bytes at the live path that are not JSON. A
     * supervisor restarts the daemon about a second later, well inside the
     * two-minute window in which the very same grant is still valid, and the
     * relay re-delivers the stub it never saw completed. Before the fix the
     * reloaded set was empty and the second execution was admitted.
     */
    const path = join(dir, "spent-grants.json");
    const first = new SpentGrants(path);
    first.load(NOW);
    expect(first.spend("grant_1", NOW, NOW)).toBe(true);

    // The interrupted write: real bytes, truncated where the crash fell.
    const whole = await readFile(path, "utf8");
    await writeFile(path, whole.slice(0, Math.floor(whole.length / 2)));

    // One second later, which is what a supervised restart costs.
    const restarted = NOW + 1_000;
    const second = new SpentGrants(path);
    second.load(restarted);

    expect(second.blockedReason(restarted)).toBeDefined();
    expect(second.spend("grant_1", NOW, restarted)).toBe(false);
  });

  it("survives the same crash when the write was atomic", () => {
    /* The other half of the remedy, and the reason the refusal above is rare
       rather than routine: with a temp-and-rename write there are no torn
       bytes at the live path to come back to. The burn is simply there. */
    const path = join(dir, "spent-grants.json");
    const first = new SpentGrants(path);
    first.load(NOW);
    first.spend("grant_1", NOW, NOW);

    const restarted = NOW + 1_000;
    const second = new SpentGrants(path);
    second.load(restarted);

    expect(second.blockedReason(restarted)).toBeUndefined();
    expect(second.has("grant_1", restarted)).toBe(true);
  });

  it("leaves no partial bytes at the live path when a write fails", async () => {
    /*
     * The durability claim, stated as the spec states it: a failed write
     * leaves the previous ledger valid and its counts intact, and may leave
     * a disposable temp file but never a half-written live one.
     *
     * The failure is forced at the rename by putting a directory where the
     * file belongs, which does not depend on who the test runs as.
     */
    const path = join(dir, "spend.json");
    const seeded = JSON.stringify({
      version: 1,
      entries: { gpt: [{ at: NOW, cents: 40 }] },
    });
    await writeFile(path, seeded);

    const ledger = new SpendLedger(path);
    await ledger.load(NOW);
    expect(ledger.spentTodayCents("gpt", NOW)).toBeCloseTo(40);

    // Every subsequent write now fails at the rename.
    const blocker = join(dir, "blocked.json");
    await mkdir(blocker, { recursive: true });
    await expect(writeLedger(blocker, "{}")).rejects.toThrow();

    // The seeded ledger is untouched and still counts.
    expect(await readFile(path, "utf8")).toBe(seeded);
    const reread = new SpendLedger(path);
    await reread.load(NOW);
    expect(reread.spentTodayCents("gpt", NOW)).toBeCloseTo(40);

    // And the temp file was cleaned up rather than left to be found later.
    const leftovers = (await readdir(dir)).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

/**
 * End to end over a real filesystem, and **not** the proof.
 *
 * These two reproduce on a laptop — twenty-five concurrent records left
 * twenty-one on disk — and they pass under the runner with the fix removed,
 * because the interleaving that loses entries did not happen there. Kept
 * because they exercise the whole path a record actually takes, and labelled
 * because a green here says nothing about whether writes are serialised.
 *
 * The property is proved in `ledger-writer.test.ts`, against an injected
 * sink, where the ordering is made to happen rather than waited for.
 */
describe("concurrent records, over a real filesystem", () => {
  it("loses none of them", async () => {
    const path = join(dir, "spend.json");
    const ledger = new SpendLedger(path);
    await ledger.load(NOW);

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        ledger.record(`backend-${String(index)}`, 1, NOW),
      ),
    );

    const written = JSON.parse(await readFile(path, "utf8")) as {
      entries: Record<string, unknown[]>;
    };
    expect(Object.keys(written.entries)).toHaveLength(25);
  });

  it("keeps a budget's count of what it accepted", async () => {
    // The same defect, the same fix, the other file — asserted rather than
    // assumed, because the two write paths are separate code.
    const path = join(dir, "budgets.json");
    const budgets = new Budgets(path, LIMITS);
    await budgets.load(NOW);

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        budgets.record(NOW + index),
      ),
    );

    const written = JSON.parse(await readFile(path, "utf8")) as {
      accepted: number[];
    };
    expect(written.accepted).toHaveLength(25);
  });
});

describe("the latch, asserted on each ledger directly", () => {
  it("will not let a budget overwrite what it could not read", async () => {
    /* Held only through `check` until now — a rider from the rolling review.
       The latch is a property of the write, so it is worth asking the write. */
    const path = join(dir, "budgets.json");
    await writeFile(path, "{ torn");
    const budgets = new Budgets(path, LIMITS);
    await budgets.load(NOW);

    await budgets.record(NOW);

    expect(await readFile(path, "utf8")).toBe("{ torn");
    expect(budgets.untrustedReason()).toBeDefined();
    expect(budgets.check(NOW, 10)).toMatchObject({
      ok: false,
      refusal: "ledger-untrusted",
    });
  });

  it("lets a trusted budget write normally", async () => {
    // The control: the latch must not be a permanent brake on a good file.
    const path = join(dir, "budgets.json");
    const budgets = new Budgets(path, LIMITS);
    await budgets.load(NOW);
    await budgets.record(NOW);

    expect(await readFile(path, "utf8")).toContain('"accepted"');
  });
});

describe("what the owner is told", () => {
  it("does not promise that own work is unaffected when it is", () => {
    /*
     * CW's rolling review. The reassurance is true of the two ledgers that
     * count what this machine did for other people, and false of the one
     * that guards the wire — which refuses the owner's own site jobs too.
     * Printed over each other, somebody would read "your own work is
     * unaffected" on the screen explaining why their own work had stopped.
     */
    const cli = readFileSync(
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "utf8",
    );
    const block = cli.slice(
      cli.indexOf("bookkeeping this device cannot read"),
      cli.indexOf("move the named file aside"),
    );

    expect(block).toContain("grantsBlocked === undefined");
    expect(block).toContain("including");
    // The strict sentence must not be the one carrying the reassurance.
    const strict = block.slice(block.indexOf("} else {"));
    expect(strict).not.toContain("own work is unaffected");
  });
});

describe("what each brake covers", () => {
  it("brakes other people's metered work and not the owner's own", async () => {
    /*
     * The scope Todd settled. `spend` and `budgets` only ever counted work
     * done for other people — the owner's jobs never consult them — so a
     * bookkeeping failure must never stop somebody using their own machine.
     * Asserted as the seam it is: the community gates close, and the route
     * classes that own-work travels on are not gated by this ledger at all.
     */
    const path = join(dir, "spend.json");
    await writeFile(path, "{ torn");
    const spend = new SpendLedger(path);
    await spend.load(NOW);

    // Community metered work: braked.
    expect(spend.hasReachedCeiling("gpt", 500, NOW)).toBe(true);
    // And the owner's own work never asks — there is no per-owner argument
    // here, because the caller does not reach this for its own jobs.
    expect(spend.untrustedReason()).toBeDefined();

    const budgets = new Budgets(join(dir, "budgets.json"), LIMITS);
    await writeFile(join(dir, "budgets.json"), "{ torn");
    await budgets.load(NOW);
    expect(budgets.check(NOW, 10)).toMatchObject({
      ok: false,
      refusal: "ledger-untrusted",
    });
  });

  it("brakes the wire completely, because a duplicate of your own job is still your money", async () => {
    /* The exception, and the reason it is one. `spent-grants` does not count
       what was done for other people; it stands between a re-delivered stub
       and a second execution. Refusing only strangers would leave the
       owner's own metered job replayable. */
    const path = join(dir, "spent-grants.json");
    await writeFile(path, "{ torn");
    const store = new SpentGrants(path);
    store.load(NOW);

    expect(store.blockedReason(NOW)).toBeDefined();
    // Refused for the acceptance horizon, then released — not forever.
    expect(
      store.blockedReason(NOW + GRANT_MAX_AGE_MS + CLOCK_SKEW_WARN_MS),
    ).toBeUndefined();
  });

  it("does not brake anything on a machine that has simply never run", async () => {
    /*
     * The control that keeps all of the above from being a different outage.
     * ENOENT is fresh state. If it were not, every new device would refuse
     * community work from the moment it was installed, and the fix would
     * read to its owner as "sharing does not work".
     */
    const spend = new SpendLedger(join(dir, "nothing-here.json"));
    await spend.load(NOW);
    expect(spend.hasReachedCeiling("gpt", 500, NOW)).toBe(false);
    expect(spend.untrustedReason()).toBeUndefined();

    const budgets = new Budgets(join(dir, "none.json"), LIMITS);
    await budgets.load(NOW);
    expect(budgets.check(NOW, 10)).toEqual({ ok: true });

    const grants = new SpentGrants(join(dir, "no-grants.json"));
    grants.load(NOW);
    expect(grants.blockedReason(NOW)).toBeUndefined();
  });
});
