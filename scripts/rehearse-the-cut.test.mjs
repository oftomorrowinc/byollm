import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rehearsal asks what it says it asks — B222.
 *
 * `rehearse-the-cut.mjs` exists so the flip's refusals arrive while nobody is
 * standing there releasing. Its first version said it asked *"every gate the
 * cut will ask"* and asked **three of `tag.sh`'s six** — a false claim in the
 * one file whose entire job is to tell the truth about the cut, and the kind
 * that is only ever discovered by the person it misled.
 *
 * The missing one that mattered was refusal 5, the pin (B234): it reads the
 * two repositories that pin this one, and it is what makes the flip a
 * **three-repository sequence** rather than a tag. `.95`, `.96` and `.97` were
 * each cut correctly and each needed that second human step afterwards; on
 * `.97` nobody took it.
 *
 * ## Why this checks source rather than running it
 *
 * The rehearsal copies a tree, bumps it and shells out to five scripts; a case
 * that ran it would be a second rehearsal, slower than the first and no more
 * true. What can go wrong silently is **coverage** — a refusal added to
 * `tag.sh` and never asked here — so that is what is compared, against
 * `tag.sh` itself rather than against a list.
 */

const REHEARSAL = fileURLToPath(
  new URL("./rehearse-the-cut.mjs", import.meta.url),
);
const TAG = fileURLToPath(new URL("./tag.sh", import.meta.url));

/** `tag.sh` numbers its refusals in comments; that numbering is the contract. */
const refusals = () =>
  [...readFileSync(TAG, "utf8").matchAll(/^# (\d+)\. (.+)$/gmu)].map((m) => ({
    number: m[1] ?? "",
    what: m[2] ?? "",
  }));

const rehearsal = () => readFileSync(REHEARSAL, "utf8");

/**
 * The rehearsal with its prose removed.
 *
 * Four mutations survived the first version of this file because every rule
 * read the whole source, and the whole source includes docstrings that DESCRIBE
 * what the script does. Deleting the `ask(...)` for the pin gate left the
 * paragraph explaining the pin gate, and the coverage rule passed on the
 * paragraph. **A refusal that is documented and not asked is the exact shape
 * this rehearsal exists to catch, arriving in the check that was supposed to
 * catch it.**
 *
 * So: coverage and behaviour are asked of the CODE; the stated limits are
 * asked of the prose, because that is where a limit belongs.
 */
const code = () =>
  rehearsal()
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^[ \t]*\/\/.*$/gmu, "");

describe("every refusal tag.sh makes", () => {
  it("is found at all, or this compares nothing", () => {
    /* A reader that matched no refusals would report perfect coverage of an
       empty set — the fail-open this repository keeps finding in its own
       checks. */
    expect(refusals().length).toBeGreaterThanOrEqual(6);
  });

  it("is named by the rehearsal, by number", () => {
    /**
     * Derived from `tag.sh`, not from a list here. A seventh refusal added
     * there fails this until the rehearsal learns about it — which is the
     * whole point, because the alternative is a rehearsal that quietly covers
     * less of the cut every time the cut gets safer.
     *
     * Two of the six cannot be ASKED from a copy and are handled rather than
     * ignored: refusal 4 is a fact about the tree at the moment you tag, so it
     * is reported from the real repository; every other one is an `ask(...)`.
     * Both spellings name their number, which is what this compares.
     */
    /* Asked of the CODE. Every refusal reaches the operator as a printed
       line naming its number — five as `ask("N. …")`, and refusal 4 in the
       sentence reported from the real tree — so the number appearing in a
       docstring is not coverage. A mutation deleting the pin gate while
       leaving the paragraph about it passed the first version of this. */
    const text = code();
    const missing = refusals()
      .map(({ number }) => number)
      .filter((number) => !text.includes(`${number}. `));
    expect(
      missing,
      "tag.sh refuses for a reason the rehearsal never mentions, so the cut has a surprise in it",
    ).toEqual([]);
  });

  it("asks the pin gate against the REAL siblings, not the copy", () => {
    /* Their pins are a fact about the world. A scratch copy of them would be
       a rehearsal of a rehearsal, and it would pass. */
    const text = code();
    expect(text).toContain("pins-checked.mjs");
    expect(text).toMatch(/pins-checked\.mjs[\s\S]{0,200}cwd: ROOT/u);
    expect(text).toContain("--manifests-only");
    expect(text).toContain("--committed");
  });

  it("warns that the siblings' CI goes red in the window, and why", () => {
    /**
     * Verified by staging the mismatch rather than by reading pnpm's docs: a
     * manifest naming one version with a lockfile resolving another fails
     * `pnpm install --frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE`,
     * exit 1, before a single test runs. Both sibling repositories use that
     * flag in every workflow.
     *
     * The window is inherent — B234 chose it deliberately, because the
     * manifests must move before the tag and a lockfile cannot name a version
     * npm has not served — so the fix is not to close it but to stop it
     * looking like a broken repository. What pnpm prints is about a lockfile;
     * nothing in it says "a release is in progress".
     */
    const text = code();
    expect(text).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(text).toContain("frozen-lockfile");
    /* And that it is expected, not merely described. A reader who meets the
       failure needs the word "not a defect" before the explanation. */
    expect(text).toMatch(/not a defect/u);
  });

  it("says the cut is three repositories when the pin gate refuses", () => {
    /* The sentence that turns a refusal into an instruction. Somebody meeting
       "11 pins disagree" without it would fix eleven lines in this repository,
       where none of them are. */
    expect(code()).toContain("THREE-REPOSITORY");
  });
});

describe("what the rehearsal claims about itself", () => {
  it("does not claim to ask every gate the cut asks", () => {
    /**
     * The original sentence, and the reason this file exists. It asked three
     * of six while saying it asked all of them, and a rehearsal that overstates
     * its coverage is worse than none: the person who trusts it stops looking.
     */
    expect(rehearsal()).not.toMatch(/asks every gate the cut/iu);
  });

  it("says out loud what it does not do", () => {
    /* `verify` and npm, named rather than absent. A limit somebody has to
       infer is a limit nobody knows about. */
    const text = rehearsal();
    expect(text).toContain("does NOT run verify");
    expect(text).toMatch(/refusal 4/iu);
  });

  it("bumps a copy, never the real tree", () => {
    /**
     * The property that makes it safe to run on a whim, and the one a careless
     * edit would break — a rehearsal that bumped the real repository would be
     * a disaster wearing the name of a safety tool.
     *
     * **The first version of this case asserted nothing.** It scanned
     * `writeFileSync(...)` arguments for `ROOT`, and the rehearsal makes no
     * `writeFileSync` calls at all — it copies and shells out. An empty list
     * satisfies "none of them names ROOT" perfectly, so a mutation setting
     * `scratch = ROOT` passed it.
     *
     * What is actually load-bearing is where `scratch` comes from and what
     * every child process is pointed at, so that is what is asked.
     */
    const text = code();
    expect(
      text,
      "the scratch directory is no longer a scratch directory",
    ).toMatch(/const scratch = mkdtempSync\(/u);
    expect(text).not.toMatch(/const scratch\s*=\s*ROOT/u);

    /* `node(...)` runs the bump and the gates. It must run them in the copy —
       `bump-version.mjs` rewrites every manifest it finds, so pointing it at
       ROOT would renumber the real repository. */
    expect(text).toMatch(/const node = \([\s\S]{0,160}cwd = scratch/u);
  });
});
