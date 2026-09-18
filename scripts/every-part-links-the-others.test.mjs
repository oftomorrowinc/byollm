import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A reader who lands on one part can reach the others — B272.
 *
 * The six package READMEs linked each other on npm and **nothing else**. Not
 * GitHub, not `byo-llm.com`, not `byollm.cloud`, not the docs.
 * `@byollm/server`'s README says `byollm.cloud` four times in prose and never
 * once as a link.
 *
 * An npm page is, for most readers, the first page of this project they ever
 * see — and it was a dead end in every direction but sideways into another npm
 * page. The root README named neither site.
 *
 * ## Why this reads the shipped files and not the generator
 *
 * The row's own words: *a check whose name claims the set is present must read
 * the shipped pages.* Asserting that `generate-family.mjs` contains four URLs
 * would pass on the day somebody deleted the marker block from a README, which
 * is the only day it matters. `--check` keeps the generated blocks in step;
 * this asks whether the result is actually in each file.
 */

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

/** Every document npm or GitHub puts in front of a stranger. */
const SHIPPED = [
  "README.md",
  "packages/daemon/README.md",
  "packages/protocol/README.md",
  "packages/server/README.md",
  "packages/relay/README.md",
  "packages/control-plane/README.md",
  "packages/conformance/README.md",
];

/**
 * The four, as links rather than as mentions.
 *
 * `](url)` and not the bare host — **a mention is not a route**, and this
 * repository's own disclosure check learned that the hard way eight lines from
 * where the law had just been applied correctly. `@byollm/server` saying
 * `byollm.cloud` four times in prose is exactly the shape that passes a
 * substring test and helps nobody.
 */
const DESTINATIONS = [
  "https://github.com/oftomorrowinc/byollm",
  "https://byo-llm.com",
  "https://byollm.cloud",
  "https://docs.byollm.cloud",
];

describe("every shipped README", () => {
  it("is found at all, or this asserts nothing", () => {
    /* A list that resolved to nothing would report perfect coverage of an
       empty set — the fail-open this repository keeps finding in its own
       checks. */
    expect(SHIPPED.length).toBe(7);
    for (const path of SHIPPED) expect(read(path).length).toBeGreaterThan(200);
  });

  it.each(SHIPPED)("routes to all four parts from %s", (path) => {
    const text = read(path);
    const missing = DESTINATIONS.filter((url) => !text.includes(`](${url})`));
    expect(
      missing,
      `${path} does not link these — a reader who lands here cannot get to them`,
    ).toEqual([]);
  });

  it("links them, rather than naming them", () => {
    /**
     * The control on the rule above, stated as its own case because the
     * failure is silent: `byollm.cloud` in prose satisfies a reader's eye and
     * no click. Asked of the one file that actually had this defect.
     */
    const server = read("packages/server/README.md");
    expect(server).toContain("](https://byollm.cloud)");
  });
});

describe("byo-llm.com", () => {
  const page = read("site/index.html");

  /**
   * The FOOTER, not the page.
   *
   * A mutation deleting GitHub and npm from the footer survived a check that
   * read the whole file: the package cards further up link npm six times, so
   * "the page contains an npm link" stayed true while the footer lost its
   * route. Verified for one occurrence, asserted for the set — the third time
   * that shape has cost me a case today.
   */
  const site = (() => {
    const from = page.indexOf("<footer");
    const to = page.indexOf("</footer>", from);
    expect(from, "the page has no footer").toBeGreaterThan(0);
    return page.slice(from, to);
  })();

  it("links the hosted product it never mentioned", () => {
    /* The page explaining what byollm IS had no route to the thing you can
       pay for, or to its documentation. It linked GitHub and npm and stopped. */
    expect(site).toContain('href="https://byollm.cloud"');
    expect(site).toContain('href="https://docs.byollm.cloud"');
  });

  it("does not link itself", () => {
    /* A footer that lists its own page teaches a reader that the list is
       decoration rather than a route. */
    expect(site).not.toContain('href="https://byo-llm.com"');
  });

  it("still links the two it already had", () => {
    /* Over-correction check: adding two must not have replaced two. */
    expect(site).toContain("https://github.com/oftomorrowinc/byollm");
    expect(site).toContain("https://www.npmjs.com/package/byollm");
  });
});

describe("a link a reader can follow from the package they installed — B295", () => {
  /**
   * The README ships **inside the tarball**, and a relative link in it points
   * at the repository layout rather than at the package. Measured before this
   * was written: all five relative links in the six published READMEs pointed
   * at paths the tarball does not contain.
   *
   *     @byollm/control-plane  src/store.ts            src/ is not shipped, only dist/
   *     byollm                 ../../docs/security.md  outside the package entirely
   *     @byollm/protocol       ../../docs/protocol.md  outside the package entirely
   *     @byollm/server         ../conformance          outside the package entirely
   *
   * So for anybody who installs the package and opens its README — the one
   * file npm guarantees to ship beside the code — every one of them was dead.
   * That is B272's finding again, from inside: *"an npm page is, for most
   * readers, the first page of this project they ever see — and it was a dead
   * end in every direction but sideways."*
   *
   * ## Why the rule is the form and not the target
   *
   * Whether npmjs.com rewrites relative links against the `repository` field
   * is a fact about somebody else's renderer, and I could not observe it: the
   * package page answers 403 to anything unbrowsery, which this repository
   * already knows. **So the rule avoids needing to know.** An absolute URL is
   * correct in the tarball, correct on GitHub and correct on npm however it
   * renders; a relative one is correct in at most two of the three, and which
   * two is unverifiable from here.
   *
   * Anchors and `mailto:` are excluded because neither resolves against a
   * base — `#status` means the same thing on every surface.
   */
  const RELATIVE = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)]+)\)/gu;

  /**
   * Package READMEs only, and the first run of this rule is why.
   *
   * It flagged the ROOT README's fourteen relative links, and they are
   * **correct**. The root package is `private`, so that file never enters a
   * tarball — it is read on GitHub, where a relative link follows the branch
   * you are looking at and an absolute one pins `main` whether you meant it or
   * not. The defect is not "relative links are bad"; it is "a file that ships
   * inside a package must not point at the repository around it".
   *
   * So the rule follows the tarball, not the file name.
   */
  const PUBLISHED_READMES = SHIPPED.filter(
    (path) => path.startsWith("packages/") && path.endsWith("README.md"),
  );

  it("is absolute in every published README", () => {
    const offenders = PUBLISHED_READMES.flatMap((path) => {
      const prose = read(path).replace(/```[\s\S]*?```/gu, "");
      return [...prose.matchAll(RELATIVE)].map(
        (m) => `${path}  ${m[0].slice(0, 60)}`,
      );
    });
    expect(
      offenders,
      "a relative link in a README that ships inside the tarball points at " +
        "the repository layout, not at the package a reader installed",
    ).toEqual([]);
  });

  it("recognises a relative link when it sees one", () => {
    /* The control. An empty offender list is also what a broken matcher
       produces, and this rule's value is that the list is empty for the right
       reason — the same trap the retired-vocabulary check fell into. */
    const sample =
      "see [the store](src/store.ts) and [security](../../docs/security.md)";
    expect([...sample.matchAll(RELATIVE)].length).toBe(2);
  });

  it("leaves absolute links, anchors and mailto alone", () => {
    const fine =
      "[docs](https://docs.byollm.cloud) [status](#status) [us](mailto:a@b.c)";
    expect([...fine.matchAll(RELATIVE)].length).toBe(0);
  });

  it("is reading READMEs at all", () => {
    /* Zero offenders across zero files is a perfect pass about nothing. */
    expect(PUBLISHED_READMES.length).toBeGreaterThan(5);
  });
});
