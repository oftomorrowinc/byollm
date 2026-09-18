import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRANT_SIGNED_FIELDS } from "./grant.js";
import { JobStub } from "./job.js";

/**
 * The lock document bounds the audience promise, and the bound is true — B239.
 *
 * `docs/schema-lock.md` now says, in its own words, that the device's audience
 * check is *"a consistency check between two things the control plane said"*
 * and **not** a guarantee against a routing party that rewrites the field —
 * because `audience` travels on the stub and the stub is not signed.
 *
 * That is a claim about the schemas, written in prose, one directory up. This
 * is the check that keeps it from becoming a sentence nobody compares.
 *
 * ## The failure it is really for
 *
 * The same document boards the hardening that closes the gap: **sign the
 * site's declared audience into the grant.** The day somebody does that, the
 * paragraph becomes false — it would be describing a weakness the product no
 * longer has, on the page people read to decide what to trust. And it would
 * become false silently, because nothing about adding a field to a signed
 * document reminds you that a page two directories away describes its absence.
 *
 * So this fails at exactly that moment, and says which paragraph to fix.
 */
const LOCK = fileURLToPath(
  new URL("../../../docs/schema-lock.md", import.meta.url),
);

const doc = readFileSync(LOCK, "utf8");
/**
 * Prose is hand-wrapped; the claim is the words, not their line breaks — nor
 * the markdown furniture around them.
 *
 * The blockquote markers are stripped for the same reason: a `>` at the start
 * of a wrapped line lands in the MIDDLE of a sentence once the newlines
 * collapse, so "the control plane said" became "the > control plane said" and
 * the first version of this file failed on its own control while the document
 * said exactly what it was asked to.
 */
const said = doc.replaceAll(/^\s*>\s?/gm, "").replaceAll(/\s+/g, " ");

describe("what the lock document says about `audience`", () => {
  it("says it, or this compares nothing", () => {
    /* The control. Every assertion below is about a paragraph's contents, and
       a missing paragraph satisfies "does not claim too much" perfectly. */
    expect(said, `${LOCK} no longer bounds the audience promise`).toContain(
      "consistency check between two things the control plane said",
    );
  });

  it("is right that `audience` is on the stub", () => {
    expect(Object.keys(JobStub.shape)).toContain("audience");
  });

  it("is right that the stub's audience is not signed into the grant", () => {
    /**
     * The load-bearing half, and the one that goes stale.
     *
     * If `audience` is ever signed into the grant — the hardening this document
     * boards — the paragraph above stops being true and starts understating
     * what the product enforces. Understating is the safer direction and it is
     * still wrong: the consent principle is about claiming neither more nor
     * less than is enforced.
     */
    expect(
      GRANT_SIGNED_FIELDS,
      "`audience` is signed into the grant now, so docs/schema-lock.md's " +
        "“What a locked promise does not promise” paragraph is " +
        "describing a weakness that no longer exists — rewrite it, and " +
        "move the hardening out of the boarded list",
    ).not.toContain("audience");
  });

  it("does not describe the check as a guarantee", () => {
    /**
     * The word matters. A reader deciding whether to route private work
     * through a control plane they do not run is deciding on this paragraph,
     * and "guarantee" is the word that would make them stop reading.
     *
     * Asserted on the paragraph rather than the whole document, because the
     * word appears elsewhere for honest reasons.
     */
    const start = said.indexOf("What a locked promise does not promise");
    const end = said.indexOf("How the lock is enforced", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paragraph = said.slice(start, end);

    expect(paragraph).toContain("is **not** a guarantee");
    expect(paragraph).toContain("not signed");
  });

  it("keeps the reason the check is not merely deleted", () => {
    /* The other direction, and the measurement that produced this paragraph.
       A future reader meeting "it is not a guarantee" and nothing else has
       every reason to delete the check; the sentence that stops them is the
       one saying what it does catch. */
    expect(said).toContain("an honest control plane's bug");
  });
});

describe("what the lock document says about the console", () => {
  /**
   * A claim about how much a thing has been used has to carry a date — B245.
   *
   * The carve-out used to justify itself with *"nobody has run a console end
   * to end yet"*. It was true when it was written and false a week later: the
   * console shipped on `.102` and one was driven, on a hosted box, before the
   * flip. Nothing about running a console makes you think of a paragraph in
   * `docs/schema-lock.md`, so the sentence simply aged in place — in the
   * document whose claims the rest of the launch copies from.
   *
   * There is no source of truth a test can read for "how many consoles have
   * been driven", and inventing one would be worse than this. What IS
   * checkable is the property that makes such a sentence survivable: **an
   * evidence claim with a date on it ages visibly, and one without it does
   * not.** A reader who meets "one person has driven one console end to end
   * (2026-09-17)" can weigh it. A reader who meets "nobody has yet" cannot
   * tell whether it was written yesterday or in August.
   *
   * So this does not check that the sentence is true. It checks that the
   * sentence is the kind that can be caught being false.
   */
  const carveOut = /The console protocol is EXPERIMENTAL\.(.*?)(?=\n- \*\*)/su
    .exec(doc)?.[1]
    ?.replaceAll(/\s+/g, " ");

  it("still carves the console out, or the rest of this checks nothing", () => {
    expect(carveOut, `${LOCK} no longer carves the console out`).toBeDefined();
  });

  it("dates the evidence it offers for the carve-out", () => {
    expect(
      carveOut ?? "",
      "the console carve-out claims something about use with no date to age it",
    ).toMatch(/\b20\d\d-\d\d-\d\d\b/u);
  });

  it("no longer says nobody has run one", () => {
    /* The cheap half, and it only catches a literal revert or a copy of the
       old line — worth one assertion because the note copies this document
       and a copy is how the claim would come back. */
    expect(carveOut ?? "").not.toMatch(/nobody has run|no one has run/iu);
  });
});
