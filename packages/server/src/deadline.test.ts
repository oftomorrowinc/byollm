import { describe, expect, it } from "vitest";
import { ENVELOPE_MAX_AGE_MS } from "@byollm/protocol";
import { deadlineFor } from "./records.js";

/**
 * One deadline rule, both planes — cloud_008 Tier 4, finding 31.
 *
 * The direct plane computed `job.deadlineAt ?? (job.claimableAt ?? now) +
 * job.ttlMs`. The cloud lane computed `record.deadlineAt ?? record.createdAt +
 * ENVELOPE_TTL_FALLBACK`, a local constant whose value happened to equal
 * `ENVELOPE_MAX_AGE_MS`. The first branch agreed and the fallback did not.
 *
 * Same field, two meanings, and the gap is widest exactly where it matters: a
 * job blocked on a dependency has a `claimableAt` hours after its `createdAt`,
 * so publishing it through a relay gave it a deadline measured from a moment
 * it could not have run.
 */

const job = (over: Partial<Parameters<typeof deadlineFor>[0]> = {}) => ({
  deadlineAt: null,
  claimableAt: null,
  ttlMs: 60_000,
  ...over,
});

describe("deadlineFor", () => {
  it("prefers a deadline the app set", () => {
    expect(deadlineFor(job({ deadlineAt: 5_000 }), 1_000)).toBe(5_000);
  });

  it("measures from when a job became claimable, not when it was created", () => {
    // `DEPENDS_ON_GATING` and `TTL_EXPIRY` already share this rule: a job that
    // waited on a dependency must not spend its life waiting.
    expect(deadlineFor(job({ claimableAt: 100_000 }), 1_000)).toBe(160_000);
  });

  it("falls back to now for a job that is claimable already", () => {
    expect(deadlineFor(job(), 1_000)).toBe(61_000);
  });

  it("is not the envelope's own ceiling", () => {
    // The cloud lane's fallback was a 24-hour constant equal to
    // `ENVELOPE_MAX_AGE_MS`, which is how long a *ciphertext* is worth
    // carrying — a different question from how long the work matters, and a
    // coincidence of values is not a shared rule.
    expect(deadlineFor(job({ claimableAt: 0 }), 0)).not.toBe(
      ENVELOPE_MAX_AGE_MS,
    );
  });
});
