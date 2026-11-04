import { describe, expect, it } from "vitest";
import { heldThroughout } from "../src/tool-checks.js";

/**
 * C041's lease assertion, on beats laid out by hand (#7265).
 *
 * The check used to require `callTimeoutMs / 1000 - 1` beats — one a second —
 * which a daemon whose tick costs real round trips cannot give: Supabase beat
 * every ~1.06s and failed on 57 while its 2s lease was never at risk. What
 * the check now asserts is coverage. These cases pin both sides: the slow
 * backend's honest cadence passes, and each way of letting the lease lapse
 * fails, named. The same three are run as daemon mutations against the
 * reference target (the #7265 log); this file keeps the arithmetic honest
 * between runs.
 */

const LEASE = "lease-1";
const LEASE_MS = 2_000;
const CLAIMED = 1_000_000;
const HELD = 60_600;

/** A beat every `everyMs` from `fromMs` after the claim until `untilMs`. */
function cadence(everyMs: number, fromMs = everyMs, untilMs = HELD) {
  const beats: { at: number; leases: string[] }[] = [];
  for (let t = fromMs; t < untilMs; t += everyMs) {
    beats.push({ at: CLAIMED + t, leases: [LEASE] });
  }
  return beats;
}

const held =
  (
    beats: { at: number; leases: string[] }[],
    over: Partial<{ leaseMs: number; heldMs: number }> = {},
  ) =>
  (): void => {
    heldThroughout({
      beats,
      leaseId: LEASE,
      claimedAt: CLAIMED,
      resultAt: CLAIMED + (over.heldMs ?? HELD),
      leaseMs: over.leaseMs ?? LEASE_MS,
    });
  };

describe("C041 the lease is held throughout — coverage, not a count", () => {
  it("passes Supabase's cadence: 57 beats in 60.6s, each ~1.06s apart", () => {
    const beats = cadence(1_060);
    expect(beats.length).toBe(57);
    expect(held(beats)).not.toThrow();
  });

  it("passes a near-zero-latency cadence, a beat a second", () => {
    expect(held(cadence(1_000))).not.toThrow();
  });

  it("fails a daemon that stops heartbeating halfway through the wait", () => {
    const beats = cadence(1_000).filter((b) => b.at < CLAIMED + HELD / 2);
    expect(held(beats)).toThrow(
      /before the result, longer than the 2000ms lease/,
    );
  });

  it("fails beats spaced 1.5 × the lease", () => {
    // First and last inside a lease of the claim and the result, so it is
    // the spacing alone that fails.
    const beats = cadence(1.5 * LEASE_MS, 1_000, 59_500);
    expect(held(beats, { heldMs: 59_500 })).toThrow(
      /heartbeats 3000ms apart, longer than the 2000ms lease/,
    );
  });

  it("fails a beat that names no lease", () => {
    const beats = cadence(1_000);
    beats[10] = { at: beats[10]?.at ?? 0, leases: [] };
    expect(held(beats)).toThrow(/the leases a heartbeat named/);
  });

  it("fails a daemon whose first beat comes a lease after the claim", () => {
    expect(held(cadence(1_000, LEASE_MS + 1))).toThrow(
      /first heartbeat came 2001ms after the claim/,
    );
  });

  it("fails a hold with no beat at all", () => {
    expect(held([])).toThrow(/no heartbeat in the 60600ms/);
  });

  it("fails a target whose lease outlasts the hold, rather than certify a renewal nothing exercised", () => {
    // One beat after the claim and one before the result: on a 90s lease
    // every other assertion passes, and nothing was renewed that needed it.
    const ends = [
      { at: CLAIMED + 100, leases: [LEASE] },
      { at: CLAIMED + HELD - 100, leases: [LEASE] },
    ];
    expect(held(ends, { leaseMs: 90_000 })).toThrow(
      /held 60600ms on a 90000ms lease, too short to show it was renewed/,
    );
    // Over two leases, the same two beats are a gap the lease cannot span.
    expect(held(ends, { leaseMs: 30_000 })).toThrow(/heartbeats \d+ms apart/);
  });
});
