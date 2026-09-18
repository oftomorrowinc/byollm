import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The refusals the SDK names are the refusals the relay sends — B261 item 15.
 *
 * `EnqueueRefused`'s docstring said **"Two codes"** and named
 * `purpose-not-declared` and `slot-unsatisfiable`. The relay has answered a
 * third since 019 §6.3 — `slot-waiting` — and nothing on this side ever
 * learned it. A site reading the SDK's own contract branched on two of three,
 * and the one it could not see is the one that says *try again later*.
 *
 * Kevin asked the question that found it: *"does `slot-unsatisfiable` also
 * cover a slot that is mapped but whose device is offline?"* It does not. That
 * case has its own code, deliberately, because the two answer different
 * questions — **does this need the person, or only time** — and a site that
 * cannot tell them apart sends somebody to a settings page to fix a sleeping
 * laptop.
 *
 * ## Why this reads two sources
 *
 * The relay and the SDK are two packages in one repository and there is no
 * shared enum: `site-plane.ts` writes the codes as string literals into
 * `fail(409, …)`, and `cloud.ts` describes them in prose for the person
 * catching the error. Nothing made them agree, which is why they did not.
 *
 * A published union would be better and is not free — it is a wire vocabulary,
 * and `strict-has-no-additive-change` applies to it in both directions. Until
 * somebody rules on that, this is the check that would have caught the drift:
 * every 409 the enqueue path can answer has to be named where a caller reads.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const cloud = read("./cloud.ts");
/**
 * The same source with comment furniture removed, for the absence checks.
 *
 * A sentence in a block comment wraps across ` * ` continuations, so a literal
 * match sees `nothing\n * to await` and not the sentence. A mutation putting
 * the contradicting claim back one word further along survived the first
 * version of this for exactly that reason — the check could not fail in the
 * way it existed to fail.
 */
const prose = cloud.replaceAll(/\s*\n\s*\*\s*/gu, " ").replaceAll(/\s+/gu, " ");
const sitePlane = read("../../relay/src/site-plane.ts");

/**
 * Every code the relay answers 409 with **on the enqueue path**.
 *
 * Parsed from the `fail(409, "code", …)` calls rather than listed here: a list
 * would be a third copy, and the drift this catches is a fourth one appearing.
 *
 * ## Scoped to the enqueue handler, and it was not
 *
 * The first version read the whole file and collected `too-late` — a 409 on a
 * *different* endpoint, about a job that already exists, which `cloud.ts`'s own
 * docstring says cannot reach enqueue as a refusal. The cases passed anyway,
 * because they only asked whether each code was named *somewhere* in
 * `cloud.ts`, and `too-late` is named there in the paragraph explaining why it
 * is irrelevant.
 *
 * So the reader was over-collecting and green by luck, which a stricter case
 * found the moment one was written. The region runs from the satisfiability
 * verdicts to the `state.enqueue` call — the span in which a refusal means the
 * job was never queued.
 */
const enqueueRegion = (): string => {
  const from = sitePlane.indexOf('answer?.verdict === "not-declared"');
  const to = sitePlane.indexOf("state.enqueue", from);
  expect(from, "the satisfiability branch moved").toBeGreaterThan(0);
  expect(to, "the enqueue call moved").toBeGreaterThan(from);
  return sitePlane.slice(from, to);
};

const refusals = (): string[] => [
  ...new Set(
    [
      ...enqueueRegion().matchAll(
        /fail\(\s*409,\s*(?:\/\/[^\n]*\n\s*)?"([a-z-]+)"/gu,
      ),
    ]
      .map((match) => match[1] ?? "")
      .filter((code) => code !== ""),
  ),
];

describe("every 409 the enqueue path can answer", () => {
  it("is found at all, or this compares nothing", () => {
    /* A reader that matched no refusals would report perfect agreement between
       two empty sets — the fail-open this repository keeps finding in its own
       checks, and the reason every reader here has a case like this. */
    expect(refusals().length).toBeGreaterThanOrEqual(3);
  });

  it("includes the one Kevin's question was about", () => {
    /* Named explicitly, because the general rule below would pass on a day
       when `slot-waiting` had been deleted from both sides at once. */
    expect(refusals()).toContain("slot-waiting");
  });

  it("is named where somebody catching the error will read it", () => {
    /**
     * `EnqueueRefused`'s own docstring and the `code` field's comment. Those
     * are what reaches a site author — the class ships in the `.d.ts`, and the
     * prose above it is the only place the vocabulary is written down.
     */
    const missing = refusals().filter((code) => !cloud.includes(code));
    expect(
      missing,
      "the relay answers a refusal the SDK never names, so a site cannot branch on it",
    ).toEqual([]);
  });

  it("no longer claims there are two of them", () => {
    /**
     * Asserted by absence against the claim rather than the list, because the
     * count is the thing that was wrong and a count is what somebody skims.
     * It said "Two codes" for the release that shipped the third.
     */
    expect(cloud).not.toMatch(/\bTwo codes\b/u);
  });

  it("says what distinguishes waiting from unsatisfiable", () => {
    /**
     * The distinction is the whole reason the code exists, and a list that
     * names it without explaining it would leave a site to guess which of the
     * two means "retry". Guessing wrong in one direction retries forever; in
     * the other it sends somebody to a settings page to fix a sleeping laptop.
     */
    expect(cloud).toMatch(/does this need the person, or only time/iu);
  });
});

describe("what the class says is worth retrying", () => {
  /**
   * Ruled 09-18, option 3: `slot-waiting` stays an `EnqueueRefused` and the
   * class stops contradicting itself in prose.
   *
   * It said *"there is nothing to await and nothing to retry — whatever the
   * code turns out to be"*, for a set containing a code whose whole meaning is
   * *try again later*. Nothing to await is true; nothing to retry is not. The
   * `.d.ts` is what a site reads, so that is where the contradiction mattered.
   *
   * The behaviour is deliberately unchanged, and the reason is worth keeping
   * near the words: `RelayUnavailable` would be a false sentence — the relay
   * is fine — and it carries a defer path built for `not-ready`, which clears
   * in seconds. A slot can wait hours. Routing hours through a seconds-scale
   * retry hammers somebody's closed laptop.
   */
  it("no longer says there is nothing to retry", () => {
    /* Asserted by absence, against the claim rather than one phrasing: it is
       the kind of confident sentence that reads well and comes back in a
       tidy-up. */
    expect(prose).not.toMatch(/nothing to await and nothing to retry/u);
  });

  it("names which refusal is worth trying again later", () => {
    expect(cloud).toMatch(/worth trying again later/iu);
  });

  it("says it of the one that clears on its own, and only that one", () => {
    /**
     * Pinned to the SET, which is what makes this more than a wording check:
     * every 409 the relay can answer is accounted for in the same paragraph,
     * so a fourth code cannot arrive and quietly inherit whichever sentence it
     * lands nearest.
     */
    const at = cloud.indexOf("worth trying again later");
    expect(at).toBeGreaterThan(0);
    const paragraph = cloud.slice(Math.max(0, at - 600), at + 400);
    for (const code of refusals())
      expect(paragraph, `${code} is not accounted for beside it`).toContain(
        code,
      );
    /* And the two that are NOT worth retrying say so where they are named. */
    expect(paragraph).toMatch(/retrying changes nothing/u);
    expect(paragraph).toMatch(/no amount of waiting helps/u);
  });

  it("keeps the behaviour it is describing", () => {
    /* The ruling was about the words. A reading that "fixed" the
       contradiction by moving `slot-waiting` into the retryable set would
       change what a deployed site's catch sees, on a code it may already
       branch on — which is the option that was explicitly not taken. */
    expect(cloud).toMatch(/RETRYABLE_AT_ENQUEUE = new Set\(\["not-ready"\]\)/u);
  });
});
