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
    const lock = readFileSync(LOCK, "utf8");
    const section = /^## What is NOT locked\b.*?$(.*?)^## /msu.exec(lock)?.[1];
    expect(
      section,
      "the lock has no carve-out section under that name",
    ).toBeDefined();

    /* Top-level bullets only: a nested `-` is elaboration of the carve-out
       above it, not a fifth one. */
    const leads = [...(section ?? "").matchAll(/^- \*\*(.+?)\*\*/gmsu)].map(
      (match) => match[1] ?? "",
    );
    const carveOuts = leads.map((lead) => {
      const code = [...lead.matchAll(/`([^`]+)`/gu)].map((m) => m[1] ?? "");
      return code.length > 0
        ? code
        : [...lead.matchAll(/\b([A-Z]{3,})\b/gu)].map((m) => m[1] ?? "");
    });

    /* A parse that found nothing satisfies "every carve-out is named", which
       is the shape this whole rewrite exists to stop being. */
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

  it("does not claim production miles it does not have", () => {
    /**
     * The one thing a version number tempts a note into. `0.1.0` is a promise
     * about the wire; the READMEs have said "not a single production mile"
     * through every alpha, and the number changing does not change that fact.
     */
    const note = words(readFileSync(NOTE, "utf8"));
    expect(note).toContain("not about production miles");
    expect(note).not.toMatch(/battle.tested|production.ready|stable release/iu);
  });
});
