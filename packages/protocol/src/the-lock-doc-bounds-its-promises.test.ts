import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRANT_SIGNED_FIELDS } from "./grant.js";
import { JobStub } from "./job.js";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./wire.js";

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

describe("what the lock document says about serving more than one version", () => {
  /**
   * **This paragraph decayed twice, and the second time it blocked a tag —
   * B336.**
   *
   * §3 promised, as a present fact, that *"additions ship as version 2 served
   * alongside version 1, routed by the version the daemon declares"*, and the
   * release note copied it. It was true of plan B. Ruling A made the opposite
   * true in the same cut: `PROTOCOL_VERSION` moved to `2`, the served set is
   * built from it, and protocol 1 is now **refused by name**. So the document
   * announcing the lock contradicted itself thirty lines apart, and the note
   * shipped to the tag that way.
   *
   * It was flagged once before it was wrong — on 09-18, as *"served alongside
   * has no mechanism"* — and the ruling that would have settled it was still
   * owed when protocol 2 arrived through a different door.
   *
   * ## Why the existing guardians missed it
   *
   * `the-flip-note-matches-the-lock.test.ts` compares the note to this
   * document, and they **agreed** — they were copies of the same false
   * sentence. `the-served-set-and-the-schemas-agree.test.ts` pins the
   * mechanism and reads no prose. Doc-vs-doc was guarded and doc-vs-code was
   * not, which is the axis the claim actually moves on: nothing about editing
   * a constant in `wire.ts` reminds you that a page two directories away
   * describes what it used to be.
   *
   * So this is asked of `SUPPORTED_PROTOCOL_VERSIONS` rather than of a list
   * here, and it is asked in BOTH directions — the day the set widens, the
   * sentence saying it has not is the one that goes stale.
   */
  const section = /\n3\. \*\*The multi-version wire(.*?)(?=\n\d\. \*\*|\n## )/su
    .exec(doc)?.[1]
    ?.replaceAll(/\s+/gu, " ");

  it("has the section at all, or the rest of this checks nothing", () => {
    /* Every assertion below is about a paragraph's contents, and a missing
       paragraph satisfies "does not overpromise" perfectly — the fail-open
       shape this suite keeps finding in its own checks. */
    expect(
      section,
      `${LOCK} no longer has a multi-version section`,
    ).toBeDefined();
  });

  it("names the number of versions this build actually serves", () => {
    /**
     * Derived from the constant, so it cannot be satisfied by a sentence that
     * was true once. While the set has one element the document must say so
     * in the words the ruling used; when it grows, that sentence must go.
     */
    const only = `speaks protocol ${PROTOCOL_VERSION}, and only ${PROTOCOL_VERSION}`;
    if (SUPPORTED_PROTOCOL_VERSIONS.length === 1) {
      expect(
        section ?? "",
        `this build serves ${PROTOCOL_VERSION} and nothing else, and ` +
          `${LOCK} §3 does not say so — it is the page people read to decide ` +
          "what their daemon may talk to",
      ).toContain(only);
      return;
    }
    expect(
      section ?? "",
      `SUPPORTED_PROTOCOL_VERSIONS now serves ` +
        `${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}, so ${LOCK} §3 still ` +
        "claiming a single version understates what the product accepts — " +
        "rewrite it, and say which versions are routed and how",
    ).not.toContain(only);
  });

  it("scopes the multi-version wire to the NEXT change, wherever it mentions it", () => {
    /**
     * The sentence that was false is still *present* — the multi-version wire
     * is the ruled operating model for the next protocol change, and deleting
     * the description would lose the design. What makes it safe is the tense,
     * so the tense is what is asserted: the words cannot appear without the
     * scope that keeps them from reading as a promise about this release.
     *
     * Asserted on the section rather than the document, because the note and
     * the upgrade guidance mention it for their own honest reasons.
     */
    if (!/alongside/iu.test(section ?? "")) return;
    expect(
      section ?? "",
      "§3 describes a version served alongside another without saying that " +
        "is the model for the next change — which is how this paragraph read " +
        "as a promise about 0.1.0 and contradicted the release note",
    ).toMatch(/next\*?\*? protocol change/iu);
    expect(section ?? "").toContain("not a property of this release");
  });

  it("does not promise that two versions are served today", () => {
    /* The literal revert, and the copy. This document is what the launch copy
       is written from, so the old sentence coming back anywhere in it is the
       failure repeating through the same door it used the first time. */
    if (SUPPORTED_PROTOCOL_VERSIONS.length > 1) return;
    expect(said).not.toMatch(/two versions can be served at once/iu);
    expect(said).not.toMatch(/Protocol 1(?:'s wire)? is STABLE/iu);
  });
});
