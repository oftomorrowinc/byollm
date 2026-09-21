import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Purpose } from "./manifest.js";

/**
 * The 0.1.0 release note says what the lock document says — B222.
 *
 * ## Why this is checked rather than proofread
 *
 * The note is the single most-read artifact of a launch after the README, and
 * **every load-bearing sentence in it is a restatement of something that lives
 * somewhere else**: the locked surfaces, the strict-is-breaking rule, the
 * carve-outs, the reserved shapes. A restatement is a copy, and this
 * repository's whole week has been copies drifting from their sources — a
 * glossary teaching a retired value, a README naming four packages of seven, a
 * threat model contradicting SECURITY.md.
 *
 * A release note that promises a lock the lock document does not make is worse
 * than all of those, because it is the sentence people quote back.
 *
 * ## It asserts overlap, not identity
 *
 * The note is prose for a reader and the lock is a specification; they are
 * meant to say the same thing differently. So what is compared is the claims
 * that must both exist — a phrase the note lifts, and the shapes it promises —
 * rather than the wording.
 */
const NOTE = fileURLToPath(
  new URL("../../../docs/release-notes/0.1.0.md", import.meta.url),
);
const LOCK = fileURLToPath(
  new URL("../../../docs/schema-lock.md", import.meta.url),
);

/* Prose wraps and is decorated. The claim is the words — the fifth lesson of
   one night: markdown `>`, JS `*`, backticks and list bullets all land
   mid-sentence once the newlines collapse. */
const words = (text: string): string =>
  text
    .replaceAll(/^\s*[>*-]\s?/gm, "")
    .replaceAll(/[`*]/g, "")
    .replaceAll(/\s+/g, " ");

/**
 * The lock's carve-out section, as this file reads it.
 *
 * A function rather than inline, because the reading is where the bugs are.
 * Every rule below is a claim about markdown nobody has written yet — a
 * bullet that lost its bold, a nested one, a fifth carve-out — and today's
 * document exercises none of them. `the reader reads` covers those; this
 * covers the document.
 */
export const readCarveOuts = (
  lock: string,
): {
  section: string | undefined;
  leads: string[];
  bullets: number;
  carveOuts: string[][];
} => {
  const section = /^## What is NOT locked\b.*?$(.*?)^## /msu.exec(lock)?.[1];
  const body = section ?? "";
  /* Top-level bullets only: an indented `-` is elaboration of the carve-out
     above it, not a fifth one. */
  const bullets = [...body.matchAll(/^- /gmu)].length;
  const leads = [...body.matchAll(/^- \*\*(.+?)\*\*/gmsu)].map(
    (match) => match[1] ?? "",
  );
  /* The tokens that cannot be paraphrased away: a lead's code spans, or its
     shouted words when it has none. */
  const carveOuts = leads.map((lead) => {
    const code = [...lead.matchAll(/`([^`]+)`/gu)].map((m) => m[1] ?? "");
    return code.length > 0
      ? code
      : [...lead.matchAll(/\b([A-Z]{3,})\b/gu)].map((m) => m[1] ?? "");
  });
  return { section, leads, bullets, carveOuts };
};

describe("the reader the carve-out check depends on", () => {
  /**
   * B246, and the reason it is here rather than only in a counterfactual.
   *
   * CW broke the first version by dropping the bold from ONE bullet: it fell
   * out of `leads`, the other three cleared the vacuity floor, and a test
   * named *"names every carve-out the lock document makes"* went green having
   * checked three of four — the exact failure it exists to fix, reached
   * through decoration rather than content.
   *
   * The lock document has four bold bullets and no nested ones, so nothing
   * about today's document can exercise a reader that mishandles either. A
   * check whose rules are only ever run against the one input that satisfies
   * them is a check whose rules are an assertion.
   */
  const SECTION = (bullets: string): string =>
    `# Lock\n\n## What is NOT locked, stated here rather than somewhere quieter\n\nCarve-outs belong in the same document as the promise.\n\n${bullets}\n\n## Something after\n\nmore\n`;

  it("counts a bullet the author forgot to bold", () => {
    const { bullets, leads } = readCarveOuts(
      SECTION(
        "- **`one` is not locked.**\n- `two` is not locked either.\n- **THREE is not locked.**",
      ),
    );
    expect(bullets).toBe(3);
    expect(leads).toHaveLength(2);
  });

  it("does not count an indented bullet as a carve-out", () => {
    /* The rule the inline comment has always claimed and nothing has ever
       run: elaboration under a carve-out is not a fifth one. Without this,
       the bullets-equal-leads line would redden on a document that is
       perfectly correct, and the fix for a false alarm is usually to delete
       the alarm. */
    const { bullets, leads } = readCarveOuts(
      SECTION(
        "- **`one` is not locked.**\n  - and here is why, at length\n- **`two` is not locked.**",
      ),
    );
    expect(bullets).toBe(2);
    expect(leads).toHaveLength(2);
  });

  it("finds a fifth carve-out without being told there is one", () => {
    const { carveOuts } = readCarveOuts(
      SECTION(
        "- **`one`.**\n- **`two`.**\n- **`three`.**\n- **`four`.**\n- **`five`.**",
      ),
    );
    expect(carveOuts).toEqual([
      ["one"],
      ["two"],
      ["three"],
      ["four"],
      ["five"],
    ]);
  });

  it("falls back to shouted words when a lead has no code span", () => {
    const { carveOuts } = readCarveOuts(
      SECTION("- **The console protocol is EXPERIMENTAL.**"),
    );
    expect(carveOuts).toEqual([["EXPERIMENTAL"]]);
  });

  it("reads nothing out of a document with no such section", () => {
    const { section, bullets, leads } = readCarveOuts(
      "# Lock\n\n## Other\n\n- **a**\n\n## End\n",
    );
    expect(section).toBeUndefined();
    expect(bullets).toBe(0);
    expect(leads).toEqual([]);
  });
});

describe("the 0.1.0 release note", () => {
  it("exists, because `tag.sh` refuses a tag without one", () => {
    /* Not a formality: the tag step reads this file, and B079's approved copy
       sat unshipped for a week because the runbook had nowhere to put it. */
    expect(existsSync(NOTE)).toBe(true);
  });

  it("carries the sentence the lock document calls its most important", () => {
    /**
     * *"Adding an optional field is a breaking change"* — on the side that has
     * not upgraded. A note that omitted it would be promising compatibility
     * while leaving out the thing that makes the promise expensive, which is
     * the half a reader has to agree to.
     */
    const note = words(readFileSync(NOTE, "utf8"));
    const lock = words(readFileSync(LOCK, "utf8"));
    const claim = "Adding an optional field is a breaking change";
    expect(lock, "the lock document no longer makes this claim").toContain(
      claim,
    );
    expect(
      note,
      "the release note drops the lock's own headline caveat",
    ).toContain(claim);
  });

  it("names every carve-out the lock document makes", () => {
    /**
     * A note that listed the promises and not the exclusions would read wider
     * than the lock, which is the direction that costs trust.
     *
     * **Derived, because the hand-written version of this test was green
     * about an omission that existed while it ran — B245.** It iterated
     * `["console", "known-models", "Refusal MESSAGES"]` under a title that
     * claims *every*, and the lock had four carve-outs. The missing one was
     * the packages' own APIs, which is the carve-out a library consumer needs
     * most: the note ends by inviting you to build against three surfaces, so
     * a reader who installs `@byollm/server` and reads only the announcement
     * concludes its exports are inside the 0.1.x promise. They are not.
     *
     * A universal name over a literal list is B084's family. The set now
     * comes from the lock's own section, so a fifth carve-out arrives here
     * without anyone remembering to add it.
     *
     * ## What counts as "the note names it"
     *
     * Overlap, not identity — the note is prose and the lock is a
     * specification, and they are meant to say the same thing differently.
     * So each carve-out is reduced to the tokens that cannot be paraphrased
     * away: the code spans in its bolded lead, or, when it has none, the
     * shouted words. `@byollm/server` survives rewording; "implementations,
     * not surfaces of their own" does not.
     */
    const { section, leads, bullets, carveOuts } = readCarveOuts(
      readFileSync(LOCK, "utf8"),
    );
    expect(
      section,
      "the lock has no carve-out section under that name",
    ).toBeDefined();

    /**
     * Every bullet in the section is a carve-out this reader saw — B246.
     *
     * CW broke the first version in one line, the way prose actually decays:
     * drop the bold from ONE bullet and it falls out of `leads`, the other
     * three still clear the vacuity floor, and a test named *"names every
     * carve-out the lock document makes"* goes green having checked three of
     * four. The exact failure it was written to fix, reached through
     * decoration rather than through content — the sixth instance of the law
     * that a mention is not a route, inside the check that closed the fifth.
     *
     * Derived rather than counted: the reader has to account for every `- `
     * it walked past. A fifth carve-out reddens through the existing path; a
     * fourth that loses its bold reddens here; and nobody maintains a number.
     */
    expect(
      leads.length,
      "a bullet in the carve-out section is not in bold, so this reader skipped it",
    ).toBe(bullets);

    /* A parse that found nothing satisfies "every carve-out is named", which
       is the shape this whole rewrite exists to stop being. Kept beside the
       equality above, which is satisfied by zero and zero. */
    expect(
      carveOuts.length,
      "parsed no carve-outs out of the lock — the section's shape moved",
    ).toBeGreaterThanOrEqual(3);
    for (const [index, tokens] of carveOuts.entries())
      expect(
        tokens.length,
        `carve-out ${String(index + 1)} reduced to nothing to check for`,
      ).toBeGreaterThan(0);

    const note = words(readFileSync(NOTE, "utf8"));
    for (const [index, tokens] of carveOuts.entries())
      for (const token of tokens)
        expect(
          note,
          `the note never says ${token} is outside the lock (carve-out ${String(index + 1)}: ${leads[index] ?? ""})`,
        ).toContain(token);
  });

  it("promises the reserved shapes the code actually reserved", () => {
    /**
     * The note tells a reader that later features land additively because
     * three shapes went in first. If one of them is not really there, that is
     * a promise about future compatibility resting on a field nobody added.
     *
     * `routing` is asserted against the SCHEMA rather than the lock document,
     * because the schema is what a third party's validator will meet.
     */
    const note = words(readFileSync(NOTE, "utf8"));
    expect(Object.keys(Purpose.shape)).toContain("routing");
    expect(note).toContain("Purpose.routing");
    expect(note).toContain("version: 1");
  });

  it("does not oversell the mileage, and does not undersell it either", () => {
    /**
     * The one thing a version number tempts a note into. `0.1.0` is a promise
     * about the wire, not about mileage — and this case used to pin the phrase
     * "not about production miles", on the reasoning that *"the READMEs have
     * said 'not a single production mile' through every alpha"*.
     *
     * **That premise is what B279 corrected and Todd overruled on 2026-09-21.**
     * The packages run byollm.cloud and a small number of integrations, and
     * B258 exists because a customer hit it in production. "No production
     * miles" was false, so a case requiring the note to say it was requiring a
     * falsehood.
     *
     * Both directions now. Overselling was the original worry; underselling is
     * the one that actually shipped, and had to be taken back out of three
     * READMEs, a marketing page and this note.
     */
    const note = words(readFileSync(NOTE, "utf8"));
    expect(note).toContain("not about mileage");
    expect(note).not.toMatch(/battle.tested|production.ready|stable release/iu);
    expect(
      note,
      "the note is back to claiming no mileage at all, which B279 found false",
    ).not.toMatch(
      /no production miles|not a single production mile|never run anywhere but/iu,
    );
  });
});
