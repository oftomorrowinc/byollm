import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The published type declarations use the vocabulary that exists — B286.
 *
 * `Audience` and `OfferScope` were `self | named | public` until the *"one
 * vocabulary"* ruling of 2026-08-24 made both `private | team`, and `public`
 * was removed outright on 08-26. The enums moved. **Six docstrings did not**,
 * and they were not internal notes: they ship.
 *
 *     server/dist/index.d.ts:275   "`audience` defaults to `self`"
 *
 * That is the hover text on `ByollmApp.enqueue`, and the code two hundred
 * lines below it reads `query.audience ?? "private"`. A site author was being
 * told the default is a value the enum cannot hold — and a reader who believed
 * it would go looking for `self` in an editor that offers `private | team`.
 *
 * ## Why this reads the BUILT declarations rather than the source
 *
 * Because that is the surface. Per-field JSDoc inside a zod object is dropped
 * by declaration generation — `ResultProvenance.untrusted`'s comment carried
 * the same mistake and reached nobody — while a docstring on an exported class
 * method survives intact. Reading `src` would mix the two and report text no
 * user can see beside text every user sees.
 *
 * ## `public` is deliberately not in the list
 *
 * It is the one whose REMOVAL is worth explaining, so it appears in prose that
 * must keep saying it: *"`public` is gone, ruled 2026-08-26"*, and the
 * Supabase adapter's note that a stored row may still hold it. Those are
 * correct and shipping them is the point. `self` and `named` have no such
 * story — they were renamed, not removed, so naming one in present-tense
 * documentation is simply the old word.
 *
 * Measured before writing: six occurrences across three published packages,
 * every one a present-tense claim, none of them history.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Words the enums no longer have, in the form documentation writes them. */
const RETIRED = [/`self`/gu, /`named`/gu];

/** Every published package's generated declarations, if it has been built. */
const declarations = () => {
  const packages = join(ROOT, "packages");
  const out = [];
  for (const entry of readdirSync(packages)) {
    const manifest = join(packages, entry, "package.json");
    if (!existsSync(manifest)) continue;
    if (JSON.parse(readFileSync(manifest, "utf8")).private === true) continue;
    const dts = join(packages, entry, "dist", "index.d.ts");
    if (existsSync(dts)) out.push({ name: entry, dts });
  }
  return out;
};

describe("the vocabulary a site author is shown", () => {
  it("has declarations to read, or it is asserting nothing", () => {
    /**
     * The fail-open this repository keeps finding. `dist` is build output, so
     * on a tree nobody has built this file would find zero declarations,zero
     * retired words, and report perfect agreement about nothing.
     *
     * `verify` builds before it tests, so this is a real precondition rather
     * than a formality — and if it ever fails, the answer is that the build
     * did not run, not that the vocabulary is clean.
     */
    const found = declarations();
    expect(
      found.length,
      "no built declarations found — run the build; this check reads dist/",
    ).toBeGreaterThanOrEqual(5);
  });

  it("recognises a retired word when it sees one", () => {
    /**
     * A mutation emptied `RETIRED` and every case still passed: zero offenders
     * is what a clean tree looks like AND what a check with no vocabulary
     * looks like. The list is the whole rule, so the list is asserted —
     * against the sentence that actually shipped, rather than against a
     * sample invented here.
     */
    const shipped =
      "     * `audience` defaults to `self` — the safe direction. Widening it means the";
    expect(
      RETIRED.some((word) => new RegExp(word.source, "u").test(shipped)),
      "the retired-word list no longer matches the line this check was written for",
    ).toBe(true);
    expect(
      RETIRED.some((word) =>
        new RegExp(word.source, "u").test("`audience` defaults to `private`"),
      ),
      "the corrected line is being reported as an offender",
    ).toBe(false);
  });

  it("never names a retired audience value in the present tense", () => {
    const offenders = declarations().flatMap(({ name, dts }) =>
      readFileSync(dts, "utf8")
        .split("\n")
        .flatMap((line, at) =>
          RETIRED.some((word) => new RegExp(word.source, "u").test(line))
            ? [`${name}/dist/index.d.ts:${String(at + 1)}  ${line.trim()}`]
            : [],
        ),
    );

    expect(
      offenders,
      "`self` and `named` became `private` and `team` on 2026-08-24; a " +
        "published docstring naming one teaches a value the enum cannot hold",
    ).toEqual([]);
  });

  it("still allows the prose that explains why `public` was removed", () => {
    /* The control on the exclusion. `public` is shipped deliberately in the
       sentences that record its removal, and a rule that swept it up would
       delete the explanation people need when they meet it in an old row. */
    const speaksOfPublic = declarations().filter(({ dts }) =>
      readFileSync(dts, "utf8").includes("`public`"),
    );
    expect(
      speaksOfPublic.length,
      "the removal note for `public` has vanished from the published types",
    ).toBeGreaterThan(0);
  });
});
