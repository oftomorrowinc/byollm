import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { removeTemp } from "./test-support.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-test-"));
});

afterEach(async () => {
  await removeTemp(dir);
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
