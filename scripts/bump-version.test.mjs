import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = readFileSync(
  new URL("./fixtures/bump-version/readme.md", import.meta.url),
  "utf8",
);
const script = fileURLToPath(new URL("./bump-version.mjs", import.meta.url));

describe("the version bump preserves README history", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("changes the live banner and leaves marked and unmarked history alone", () => {
    root = mkdtempSync(join(tmpdir(), "byollm-bump-version-"));
    mkdirSync(join(root, "packages/protocol"), { recursive: true });
    mkdirSync(join(root, "packages/daemon/src"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });

    writeFileSync(
      join(root, "packages/protocol/package.json"),
      '{\n  "version": "0.1.0-alpha.21"\n}\n',
    );
    writeFileSync(join(root, "packages/protocol/README.md"), fixture);
    writeFileSync(
      join(root, "packages/daemon/package.json"),
      '{\n  "version": "0.1.0-alpha.21"\n}\n',
    );
    writeFileSync(join(root, "README.md"), fixture);
    writeFileSync(
      join(root, "site/index.html"),
      "<b>Alpha (0.1.0-alpha.21) — active</b>\n",
    );
    writeFileSync(
      join(root, "packages/daemon/src/index.ts"),
      'export const DAEMON_VERSION = "0.1.0-alpha.21";\n',
    );

    execFileSync(process.execPath, [script, "0.1.0-alpha.22"], { cwd: root });

    const after = readFileSync(
      join(root, "packages/protocol/README.md"),
      "utf8",
    );

    expect(after).toContain("**Alpha (`0.1.0-alpha.22`) ");
    expect(after).toContain("<!-- release-note 0.1.0-alpha.21 -->");
    expect(after).toContain("so `0.1.0-alpha.21` is that release, whole.");
    expect(after).toContain("`0.1.0-alpha.8`.");
    expect(after).toContain("Breaking in `0.1.0-alpha.12`");
    expect(after.match(/0\.1\.0-alpha\.22/g)).toHaveLength(1);

    expect(
      readFileSync(join(root, "packages/protocol/package.json"), "utf8"),
    ).toContain('"version": "0.1.0-alpha.22"');
    expect(readFileSync(join(root, "site/index.html"), "utf8")).toContain(
      "Alpha (0.1.0-alpha.22)",
    );
    expect(
      readFileSync(join(root, "packages/daemon/src/index.ts"), "utf8"),
    ).toContain('DAEMON_VERSION = "0.1.0-alpha.22"');
  });
});

describe("a bump to a RELEASE retires the alpha, and only mechanically", () => {
  /**
   * B252, CW's ruling: *"on a non-prerelease target the bumper removes the
   * banner and rewrites the mechanical `@alpha` suffixes; the gate stays as
   * the backstop, not the instrument."*
   *
   * Before this, `bump-version.mjs 0.1.0` rewrote the number INSIDE the alpha
   * banner and left the banner, producing *"Alpha (`0.1.0`) — don't use this
   * yet"* on eight READMEs — and the cut then met a fourteen-item refusal from
   * `alpha-claims-match-the-version.mjs` in the middle of a release.
   *
   * The bumper is the right owner because it already holds the rule for which
   * lines are live, and the gate took that rule from here so the two cannot
   * drift.
   */
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const tree = () => {
    root = mkdtempSync(join(tmpdir(), "byollm-bump-release-"));
    mkdirSync(join(root, "packages/protocol"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(
      join(root, "packages/protocol/package.json"),
      '{\n  "version": "0.1.0-alpha.21"\n}\n',
    );
    return root;
  };

  it("deletes the markdown banner instead of renumbering it", () => {
    const at = tree();
    writeFileSync(
      join(at, "packages/protocol/README.md"),
      "> **Alpha (`0.1.0-alpha.21`) — under active development.**\n\n# Package\n\nBody.\n",
    );
    execFileSync(process.execPath, [script, "0.1.0"], { cwd: at });

    const after = readFileSync(join(at, "packages/protocol/README.md"), "utf8");
    expect(after).not.toContain("Alpha (");
    /* And it does not leave the hole behind: the banner is followed by a blank
       line in every README, and removing one without the other starts the
       document with two. */
    expect(after.startsWith("# Package")).toBe(true);
  });

  it("drops the `@alpha` dist-tag from install and npx lines", () => {
    /* The half that is worse than a stale adjective: the flip moves `latest`
       and nothing moves `alpha`, so these keep resolving to the last
       prerelease and a reader installs an OLDER package than the one just
       locked. */
    const at = tree();
    writeFileSync(
      join(at, "README.md"),
      "Run `npm install @byollm/protocol@alpha`.\n" +
        "Then `npx --package @byollm/server@alpha keygen`.\n",
    );
    execFileSync(process.execPath, [script, "0.1.0"], { cwd: at });

    const after = readFileSync(join(at, "README.md"), "utf8");
    expect(after).toContain("npm install @byollm/protocol`");
    expect(after).toContain("npx --package @byollm/server keygen");
    expect(after).not.toContain("@alpha");
  });

  it("maintains the banner's version after the 0.1.0 cut changed its shape", () => {
    /**
     * **The rule read `<b>Alpha (` only.** At the cut the banner became
     * `<b>0.1.0 — early.</b>`, and a number-maintainer that no longer matches
     * its line leaves the marketing page naming 0.1.0 for ever.
     *
     * `check-site.mjs` requires the version to be in that file, so the
     * staleness would be loud — at the NEXT cut, which is still worse than
     * maintained. Only the number moves here; which sentences survive a flip
     * stays a hand edit, which is what the case below is about.
     */
    root = mkdtempSync(join(tmpdir(), "bump-shape-"));
    mkdirSync(join(root, "site"), { recursive: true });
    mkdirSync(join(root, "packages/protocol"), { recursive: true });
    writeFileSync(
      join(root, "packages/protocol/package.json"),
      '{\n  "version": "0.1.0"\n}\n',
    );
    writeFileSync(
      join(root, "site/index.html"),
      '<div class="alpha"><div class="wrap">\n  <b>0.1.0 — early.</b>\n</div></div>\n',
    );
    execFileSync(process.execPath, [script, "0.1.1"], { cwd: root });
    expect(readFileSync(join(root, "site/index.html"), "utf8")).toContain(
      "<b>0.1.1 — early.</b>",
    );
  });

  it("maintains the README banner too, and only its own number", () => {
    /**
     * **The sibling of the case above, missing for five weeks — found at the
     * 0.1.1 cut.**
     *
     * The site rule was widened when the flip changed the banner's shape. The
     * README rule was not: it still read `> **Alpha (\`` only, so from 0.1.0
     * onward the bumper silently stopped maintaining the most-read line in the
     * repository. `pnpm verify` caught it at the next cut, exactly as the
     * comment beside the site rule predicted — and "loud at the next cut is
     * still worse than maintained".
     *
     * ## And why the line is not renumbered wholesale
     *
     * Todd's approved wording carries TWO versions on one line: the banner's
     * own, and *"the protocol is version 2 as of 0.1.0"*, a permanent fact
     * about when protocol 2 arrived. `split/join` moves both and produces
     * "version 2 as of 0.1.1" — false the moment it is written, in the
     * warning a visitor reads first.
     */
    root = mkdtempSync(join(tmpdir(), "bump-readme-banner-"));
    mkdirSync(join(root, "packages/protocol"), { recursive: true });
    writeFileSync(
      join(root, "packages/protocol/package.json"),
      '{\n  "version": "0.1.0"\n}\n',
    );
    writeFileSync(
      join(root, "README.md"),
      "> [!WARNING]\n" +
        "> **`0.1.0` — early.** The protocol is version 2 as of 0.1.0; the\n" +
        "> software is still early.\n\n# BYOLLM\n",
    );
    execFileSync(process.execPath, [script, "0.1.1"], { cwd: root });
    const after = readFileSync(join(root, "README.md"), "utf8");
    expect(after, "the banner's own version did not move").toContain(
      "**`0.1.1` — early.**",
    );
    expect(
      after,
      "the historical sentence was renumbered — protocol 2 arrived at 0.1.0 " +
        "and always will have",
    ).toContain("version 2 as of 0.1.0");
  });

  it("leaves the site's banner alone, because that block is not mechanical", () => {
    /**
     * I wrote the HTML rules first and they broke the page. The orange bar is
     * one `<div>` carrying the alpha warning AND a feature announcement, so a
     * line filter either orphans that text in `<body>` or deletes a paragraph
     * that has nothing to do with being an alpha.
     *
     * Which sentences survive is a judgement, and a script making it silently
     * on the marketing site during a flip is worse than a line on a list. The
     * gate names it as a hand edit instead.
     */
    const at = tree();
    writeFileSync(
      join(at, "site/index.html"),
      '<div class="alpha"><div class="wrap">\n' +
        "  <b>Alpha (0.1.0-alpha.21) — active</b>\n" +
        "  <b>Team routing:</b> share a model with people you name.\n" +
        "</div></div>\n",
    );
    execFileSync(process.execPath, [script, "0.1.0"], { cwd: at });

    const after = readFileSync(join(at, "site/index.html"), "utf8");
    expect(after).toContain("Team routing:");
    expect(after).toContain('<div class="alpha">');
    expect(after).toContain("</div></div>");
    /* Renumbered, as it always was — the banner is still live version state. */
    expect(after).toContain("<b>Alpha (0.1.0) — active</b>");
  });

  it("does none of it on an alpha-to-alpha bump", () => {
    /* The control. Every bump until now was one of these, and retiring the
       banner on one would delete the warning while the thing is still an
       alpha — the same defect mirrored. */
    const at = tree();
    writeFileSync(
      join(at, "README.md"),
      "> **Alpha (`0.1.0-alpha.21`) — under active development.**\n\n" +
        "Run `npm install @byollm/protocol@alpha`.\n",
    );
    execFileSync(process.execPath, [script, "0.1.0-alpha.22"], { cwd: at });

    const after = readFileSync(join(at, "README.md"), "utf8");
    expect(after).toContain("**Alpha (`0.1.0-alpha.22`) ");
    expect(after).toContain("@byollm/protocol@alpha");
  });
});
