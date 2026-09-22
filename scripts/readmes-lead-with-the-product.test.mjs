import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A README opens with the product, not with its release history — B340.
 *
 * `release-note.mjs` prepends a note to every package README and nothing ever
 * retired one. By 0.1.0 that had accumulated to **322 lines above `# BYOLLM`**
 * in the root README and 103–129 above each package's own title, so GitHub
 * rendered a year of alpha notes before the project's first sentence.
 *
 * **And npm serves the tarball's README**, so `npm view byollm@0.1.0 readme`
 * opened with *"`alpha.15` is a breaking wire change, and it breaks daemons
 * and relays"* — on the release whose entire subject is that the wire is now
 * locked, to a reader deciding whether to depend on it.
 *
 * The history is not deleted: 23 notes were recovered into
 * `docs/release-notes/` and `CHANGELOG.md` indexes all 41. What is refused is
 * a README accumulating them again, which is the only way this comes back —
 * one prepend at a time, each of them individually reasonable.
 */

const PACKAGES = readdirSync("packages").filter((d) =>
  existsSync(join("packages", d, "README.md")),
);
const readme = (p) => readFileSync(p, "utf8");
const MARKER = /<!-- release-note [0-9a-z.-]+ -->/gu;
const ALPHA_NOTE = /^>\s*\*\*`(?:0\.1\.0-)?alpha\.\d+`/mu;

describe("what a package README opens with", () => {
  it("finds the packages at all, or this checks nothing", () => {
    /* The control. An empty list satisfies every rule below perfectly, which
       is the fail-open this repository keeps finding in its own checks. */
    expect(PACKAGES.length).toBeGreaterThan(3);
  });

  it.each(PACKAGES)("packages/%s — reaches its title quickly", (dir) => {
    /**
     * Not "starts with its title" — that rule was written first and was
     * **wrong**, caught by mutating it: `release-note.mjs` prepends the
     * CURRENT release's note by design, and CW's rule is "at most the current
     * release's note", not none. A gate that refused one note would have
     * refused the mechanism it was written to protect, and the next person to
     * cut a release would have deleted the gate rather than the note.
     *
     * So what is bounded is the DISTANCE. One note is a screen; the state this
     * exists to refuse was 103–129 lines, and no single prepend was ever the
     * one that went too far.
     */
    const lines = readme(join("packages", dir, "README.md")).split("\n");
    const title = lines.findIndex((l) => l.startsWith("# "));
    expect(
      title,
      `packages/${dir}/README.md has no '# ' title`,
    ).toBeGreaterThan(-1);
    expect(
      title,
      `packages/${dir}/README.md buries its title ${String(title)} lines down — ` +
        "npm shows this at the top of the package page",
    ).toBeLessThan(40);
  });

  it.each(PACKAGES)("packages/%s — carries at most one release note", (dir) => {
    /**
     * At most ONE, not none: `release-note.mjs` putting the current release's
     * note at the top is the design and stays. What is refused is the second
     * one, because that is the shape that reached 109 lines — every single
     * prepend was reasonable and nothing was ever the one that went too far.
     */
    const text = readme(join("packages", dir, "README.md"));
    const markers = text.match(MARKER) ?? [];
    expect(
      markers.length,
      `packages/${dir}/README.md carries ${String(markers.length)} release ` +
        "notes; retire the older ones to docs/release-notes/ and rebuild " +
        "CHANGELOG.md with `node scripts/changelog.mjs`",
    ).toBeLessThanOrEqual(1);
  });
});

describe("what the root README opens with", () => {
  const root = readme("README.md");

  it("puts the project's title near the top", () => {
    /**
     * Not "at the top" — the approved warning block is deliberately above it,
     * and that is the one thing a visitor should read first. Twenty lines is
     * the warning plus the centred header; three hundred is a changelog.
     */
    const title = root.split("\n").findIndex((l) => l.startsWith("# BYOLLM"));
    expect(title, "# BYOLLM is missing from README.md").toBeGreaterThan(-1);
    expect(
      title,
      "README.md has grown a preamble again — GitHub renders it before the " +
        "project's first sentence",
    ).toBeLessThan(40);
  });

  it("does not accumulate release notes", () => {
    expect(
      ALPHA_NOTE.test(root),
      "README.md carries an alpha release note; it belongs in " +
        "docs/release-notes/ with a line in CHANGELOG.md",
    ).toBe(false);
    expect((root.match(MARKER) ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe("the history the READMEs gave up", () => {
  it("is all still here, and indexed", () => {
    /**
     * The half that makes the deletions above safe to have made. Twenty-three
     * notes were recovered out of READMEs and nothing else held them —
     * `docs/release-notes/` started at alpha.87.
     */
    const notes = readdirSync("docs/release-notes").filter((f) =>
      f.endsWith(".md"),
    );
    expect(notes.length).toBeGreaterThan(38);
    for (const old of ["0.1.0-alpha.3", "0.1.0-alpha.15", "0.1.0-alpha.58"]) {
      expect(notes, `${old} was in a README and is now nowhere`).toContain(
        `${old}.md`,
      );
    }
    const changelog = readme("CHANGELOG.md");
    for (const note of notes) {
      expect(changelog, `CHANGELOG.md does not index ${note}`).toContain(note);
    }
  });
});
