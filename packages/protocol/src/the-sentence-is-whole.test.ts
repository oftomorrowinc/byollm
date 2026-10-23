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
  it("is the sentence Todd ruled, word for word", () => {
    /* #4058, 10-22, verbatim. The whole literal rather than its keywords: the
       last version of this test checked for "sees only what routing and
       metering need", which is the opening that ruling removed — a keyword
       pin keeps passing on any sentence that kept the keyword, and fails on
       none that lost a clause. */
    expect(HUB_FENCE).toBe(
      "byollm.cloud sees who asked, which devices and sites are connected, " +
        "which device did each job, and each job's kind, size, outcome and " +
        "time. Never prompts, never answers, never credentials.",
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

      /**
       * And not as a TRUNCATION of a longer word, which plain containment
       * accepts.
       *
       * A mutation found this on the day the module moved into protocol:
       * shortening the clause `"and timestamps"` to `"and times"` passed,
       * because one is a prefix of the other (today it is `"and tim"`
       * against `"and time"`). The clause text is what maps
       * promise-words to columns, so a clause claiming words the sentence does
       * not actually end on is a mapping to a phrase nobody printed — the same
       * "a mention is not a route" this file exists to prevent across two
       * repositories, arriving inside the check that prevents it.
       */
      const after = HUB_FENCE.charAt(
        HUB_FENCE.indexOf(clause.says) + clause.says.length,
      );
      expect(
        /[A-Za-z]/u.test(after),
        `"${clause.says}" is a truncation of a longer phrase in the fence, not a clause of it`,
      ).toBe(false);
    }
  });

  it("claims only columns the hub records, and every one of them", () => {
    /**
     * The hub's RECORDED, copied — a restatement, so it can rot, and here is
     * how to re-check it. The source is `byollm-cloud`'s
     * `hub/test/what-the-hub-keeps.test.ts`, the `RECORDED` constant:
     *
     *   git -C ../byollm-cloud show origin/main:hub/test/what-the-hub-keeps.test.ts \
     *     | sed -n '/^const RECORDED/,/^};/p'
     *
     * As of 10-22 that is usage_events (id, at, owner_id, site_id, job_id,
     * kind, size_class, disposition, price_version) and usage_bytes
     * (member_id, site_id, month, bytes, updated_at). `served_by_owner_id` is
     * the pair row's device owner, which the hub card after this one adds to
     * RECORDED with its table (#4058 shape (c), replacing #4035's 0010), and
     * `first_at`/`last_at` are that table's two times (#4131); until it lands,
     * this list is ahead of the hub by those three columns, on purpose.
     *
     * This checks the clause list against that copy in both directions. The
     * hub's own suite is the real check — it reads the schema and refuses a
     * column no clause claims — but it runs against whatever version it pins,
     * so a clause naming a column the hub does not keep (a typo, a rename)
     * would sit in a published release until somebody bumped the pin. Here it
     * fails before the publish.
     */
    const recorded = [
      // usage_events
      "id",
      "at",
      "owner_id",
      "site_id",
      "job_id",
      "kind",
      "size_class",
      "disposition",
      "price_version",
      // usage_bytes
      "member_id",
      "month",
      "bytes",
      "updated_at",
      // the pair row (#4058), usage_served_by, arriving with the hub card #4131
      "served_by_owner_id",
      "first_at",
      "last_at",
    ];
    const claimed = HUB_FENCE_CLAUSES.flatMap((clause) => clause.covers);
    expect(
      claimed.filter((column) => !recorded.includes(column)),
      "a clause claims a column the hub does not record",
    ).toEqual([]);
    expect(
      recorded.filter((column) => !claimed.includes(column)),
      "the hub records a column no clause claims",
    ).toEqual([]);
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
