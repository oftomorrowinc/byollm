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
const sitePlane = read("../../relay/src/site-plane.ts");

/**
 * Every code the relay answers 409 with.
 *
 * Parsed from the `fail(409, "code", …)` calls rather than listed here: a list
 * would be a third copy, and the drift this catches is a fourth one appearing.
 */
const refusals = (): string[] => [
  ...new Set(
    [...sitePlane.matchAll(/fail\(\s*409,\s*(?:\/\/[^\n]*\n\s*)?"([a-z-]+)"/gu)]
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
