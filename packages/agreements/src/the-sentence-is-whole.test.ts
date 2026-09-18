import { describe, expect, it } from "vitest";
import { HUB_FENCE, HUB_FENCE_CLAUSES } from "./index.js";

/**
 * The shared sentence, checked where it is defined — B039.
 *
 * Two repositories import this and each checks something the other cannot:
 * `byollm-cloud` proves every recorded column is claimed by a clause,
 * `byollm-cloud-web` proves the page ships these exact words. What neither of
 * them can check is that the sentence and its clause list agree with each
 * other, because that is a fact about this module.
 *
 * It is the fact most likely to rot. A clause edited for readability, on the
 * page or here, silently stops matching the sentence it claims to be a clause
 * of — and the column check keeps passing, because it never reads the
 * sentence.
 */
describe("the hub fence", () => {
  it("is one sentence pair, and says the two things it must", () => {
    /* The promise has a positive half and a negative half, and the negative
       half is the one people came for. A sentence that lost it would still
       read as a privacy statement. */
    expect(HUB_FENCE).toContain("sees only what routing and metering need");
    expect(HUB_FENCE).toContain(
      "Never prompts, never answers, never credentials.",
    );
  });

  it("contains every clause that claims to be part of it", () => {
    /**
     * The check neither consumer can make.
     *
     * `byollm-cloud` maps clauses to columns and never reads the sentence;
     * `byollm-cloud-web` pins the sentence and never reads the clauses. A
     * clause reworded on either side would leave a promise mapped to columns
     * by words the page does not print.
     *
     * The plumbing clause is exempt by its own ruling and says so in its text,
     * which is what makes it exempt rather than missed — a parenthetical is
     * not a clause of the sentence, it is a note about what the sentence
     * deliberately does not cover.
     */
    for (const clause of HUB_FENCE_CLAUSES) {
      if (clause.says.startsWith("(")) continue;
      expect(
        HUB_FENCE,
        `"${clause.says}" claims to be a clause of the fence and is not in it`,
      ).toContain(clause.says);
    }
  });

  it("has at least one clause that is not the exemption", () => {
    /* The control. Every assertion above is satisfied by a list of nothing but
       parentheticals, and a promise that covers no columns is not a promise. */
    const real = HUB_FENCE_CLAUSES.filter(
      (clause) => !clause.says.startsWith("("),
    );
    expect(real.length).toBeGreaterThan(2);
  });

  it("claims no column twice", () => {
    /**
     * Two clauses covering one column means the column is disclosed twice and
     * removing either clause still passes the consumer's check — so a clause
     * could be deleted from the page and nothing would notice the promise got
     * narrower.
     */
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const clause of HUB_FENCE_CLAUSES) {
      for (const column of clause.covers) {
        if (seen.has(column)) twice.push(column);
        seen.add(column);
      }
    }
    expect(twice, "a column claimed by two clauses").toEqual([]);
  });

  it("is frozen, so an importer cannot edit the promise in place", () => {
    /* Two repositories import this at runtime. A mutable array is a promise
       any consumer can quietly narrow for itself, in memory, and every check
       downstream would agree with the narrowed version. */
    expect(Object.isFrozen(HUB_FENCE_CLAUSES)).toBe(true);
    for (const clause of HUB_FENCE_CLAUSES) {
      expect(Object.isFrozen(clause.covers)).toBe(true);
    }
  });
});
