import { describe, expect, it } from "vitest";
import { POLL_LADDER, POLL_JITTER_MS, pollDelay, nextRung } from "./runner.js";

/**
 * The adaptive poll ladder — B212, Todd's design, ruled 09-15.
 *
 * **The flat cadence WAS the perceived slowness.** Every chat message is a
 * job, and every job waited up to a full interval for pickup, so a
 * conversation paid ~10s per turn before a model saw a word of it.
 *
 * These cases are about the SHAPE — the rungs, and the two properties the
 * ruling insists on keeping. The loop's own behaviour (reset on a claim,
 * climb on an empty tick, wake on a completion) is driven in
 * `runner.test.ts`, where a runner can be stepped.
 */
describe("the rungs a poll climbs", () => {
  it("starts at zero and tops out at one whole interval", () => {
    /* Todd's 0/1/2/4/6/8/10 at the default 10s, expressed as fractions so a
       deployment with a different cadence gets the same shape instead of a
       ladder that climbs past its own ceiling. */
    expect(POLL_LADDER[0]).toBe(0);
    expect(POLL_LADDER.at(-1)).toBe(1);
    expect([...POLL_LADDER].map((rung) => rung * 10)).toEqual([
      0, 1, 2, 4, 6, 8, 10,
    ]);
  });

  it("only ever climbs", () => {
    /* A rung that went backwards would make the delay depend on how a tick
       was counted rather than on how long the device has been idle. */
    const rising = [...POLL_LADDER].every(
      (rung, at) => at === 0 || rung > (POLL_LADDER[at - 1] ?? 0),
    );
    expect(rising).toBe(true);
  });

  it("keeps a tie-break wide enough to be luck at the fast end", () => {
    /**
     * B194's property: two devices racing for one job tie by luck, not by
     * clock speed. At a 1-second rung the old ±15% would be ±150ms — tight
     * enough that the device with the faster clock wins every follow-up,
     * which is the picker B194 declined to build.
     *
     * The additive jitter has to be a real fraction of the smallest non-zero
     * rung, or the ladder quietly turns routing into a speed contest.
     */
    const smallestRealRung = 10_000 * POLL_LADDER[1];
    expect(POLL_JITTER_MS.span).toBeGreaterThan(0);
    expect(
      POLL_JITTER_MS.min + POLL_JITTER_MS.span,
      "jitter is a meaningful share of the first real rung",
    ).toBeGreaterThan(smallestRealRung * 0.25);
  });

  it("does not shrink the herd desync it inherited, at the ceiling", () => {
    /**
     * The ruling's third note, and the one a ladder breaks by accident. `±15%`
     * of 10s is ±1.5s of fleet desynchronisation, and it exists so idle
     * daemons do not synchronise into a herd against one server. The ladder's
     * additive jitter is ±0.35s — five times narrower.
     *
     * **Driven through `pollDelay`, not asserted between two constants.** The
     * first version of this case compared `POLL_JITTER_MS.span` with `10_000 *
     * 0.3` and stayed green when the entire ceiling branch was deleted: it
     * described the constants truthfully and said nothing about the function.
     */
    const ceiling = POLL_LADDER.length - 1;
    const low = pollDelay(ceiling, 10_000, () => 0);
    const high = pollDelay(ceiling, 10_000, () => 1);

    expect(low, "the bottom of ±15%").toBeCloseTo(8_500, -1);
    expect(high, "the top of ±15%").toBeCloseTo(11_500, -1);
    expect(
      high - low,
      "a spread the additive jitter could not produce",
    ).toBeGreaterThan(POLL_JITTER_MS.span * 2);
  });

  it("puts the small additive jitter on the rungs below it", () => {
    /* And the fast end keeps a tie-break wide enough to be luck: at the first
       real rung, ±15% would be ±150ms — tight enough that the faster clock
       wins every follow-up, which is the picker B194 declined to build. */
    const first = pollDelay(1, 10_000, () => 0);
    const last = pollDelay(1, 10_000, () => 1);
    expect(first).toBe(1_000 + POLL_JITTER_MS.min);
    expect(last).toBe(1_000 + POLL_JITTER_MS.min + POLL_JITTER_MS.span);
  });

  it("never returns a bare zero, so two devices cannot dead-heat", () => {
    /* Step 0 is "immediately" in product terms, not literally: a pair of
       devices both waking on the same completion must still pick randomly. */
    expect(pollDelay(0, 10_000, () => 0)).toBeGreaterThan(0);
  });
});

describe("which rung a tick leaves the loop on", () => {
  it("climbs one rung for every tick that took nothing", () => {
    let step = 0;
    const climb = [0, 1, 2, 3, 4, 5, 6, 6, 6].map(
      () => (step = nextRung(step, 0)),
    );
    expect(climb).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 6]);
  });

  it("drops to the first rung the moment it takes work", () => {
    /* The whole point: the device that just claimed is the one a follow-up is
       likely for, so it stops waiting. Conversation stickiness falls out of
       this — one device and one model for a chat, which also softens B197's
       mixed-model surprise. */
    expect(nextRung(6, 1)).toBe(0);
    expect(nextRung(3, 2)).toBe(0);
  });

  it("stops at the ceiling rather than running off the ladder", () => {
    /* An unbounded climb would index past the rungs and fall back to the
       `?? 1` default — the right delay by accident, which is the kind of
       correctness that stops being correct when somebody adds a rung. */
    expect(nextRung(POLL_LADDER.length - 1, 0)).toBe(POLL_LADDER.length - 1);
    expect(nextRung(999, 0)).toBe(POLL_LADDER.length - 1);
  });
});
