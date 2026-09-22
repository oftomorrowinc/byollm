import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROSS_REPO } from "./alpha-claims-match-the-version.mjs";
import { describe, expect, it } from "vitest";

/**
 * The docs stop saying "alpha" when the version stops being one — B222.
 *
 * `bump-version.mjs` rewrites the version INSIDE the alpha banner and never
 * removes the banner, so the flip commit would have published
 * *"Alpha (`0.1.0`) — under active development. Don't use this yet."* on eight
 * READMEs and the site, in the change that makes the repository public.
 *
 * And the banner is the smaller half: the docs carry live instructions pinned
 * to the `alpha` dist-tag, which the flip does not move. `npm install
 * @byollm/protocol@alpha` and `npx --package @byollm/server@alpha keygen` would
 * keep resolving to the last prerelease, so a reader following our own
 * quickstart installs an **older** package than the one just locked — and it
 * looks like their mistake.
 *
 * Every case drives the real script by exit code, the shape `pins-agree` takes
 * and for the same reason: a gate that has never been shown failing is a gate
 * nobody has tested.
 */

const SCRIPT = fileURLToPath(
  new URL("./alpha-claims-match-the-version.mjs", import.meta.url),
);
const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The script, by exit code.
 *
 * `execFileSync` with a fixed argv rather than `spawnSync`: byollm_004 §2 bans
 * the shell-invoking APIs and eslint enforces it, which caught the first draft
 * of this file. It throws on a non-zero exit, so the failure carries the
 * status and the streams and the catch is where the interesting cases land.
 */
const run = (root) => {
  const options = {
    encoding: "utf8",
    env: { ...process.env, ALPHA_CLAIMS_ROOT: root },
  };
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT], options) };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
};

/** A tree with one protocol version and whatever documents a case needs. */
const tree = (version, files) => {
  const root = mkdtempSync(join(tmpdir(), "alpha-claims-"));
  mkdirSync(join(root, "packages", "protocol"), { recursive: true });
  writeFileSync(
    join(root, "packages", "protocol", "package.json"),
    JSON.stringify({ name: "@byollm/protocol", version }),
  );
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  return root;
};

const BANNER =
  "> **Alpha (`0.1.0-alpha.102`) — under active development. Don't use this yet.**\n";

describe("at a clean version", () => {
  it("refuses the banner the bumper would have left behind", () => {
    /* The exact string `bump-version.mjs 0.1.0` produces: the version inside
       the banner is rewritten and the word around it is not. */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\n> **Alpha (`0.1.0`) — under active development. Don't use this yet.**\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
    expect(out).toContain("B222");
  });

  it("refuses an install instruction pinned to the alpha tag", () => {
    /* The half that is worse than a stale adjective. `latest` moves at the
       flip and `alpha` does not, so this line installs the PREVIOUS release. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
  });

  it("refuses the same claim in a package README or on the site", () => {
    /* Nine documents, and the walk has to reach all of them. A check that
       only read the root README would have passed the flip with seven
       banners still standing. */
    const root = tree("0.1.0", {
      "packages/server/README.md": "# server\n\n`@byollm/server@alpha`\n",
      "site/index.html": '<meta content="Alpha software, under development">\n',
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("packages/server/README.md");
    expect(out).toContain("site/index.html");
  });

  it("sees the site's own banner, which is HTML and not markdown", () => {
    /**
     * The hole this reader shipped with, found by B252 four hours later.
     *
     * Eight READMEs carry a markdown blockquote banner; `byollm.dev` carries
     * an orange bar with `<b>Alpha (…)`. `bump-version.mjs` has always known
     * about both. This reader knew about one, because markdown READMEs were
     * the only input it was ever run against — and the banner it could not see
     * is the alpha warning the most people actually look at.
     *
     * Standing instruction 0's second companion, arriving in the check the
     * companion was written beside.
     */
    const root = tree("0.1.0", {
      "site/index.html":
        '<div class="alpha"><div class="wrap">\n' +
        "  <b>Alpha (0.1.0) — under active development.</b>\n" +
        "</div></div>\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("site/index.html:2");
  });

  it("does not read a CSS class named alpha as a claim", () => {
    /* The control, and the direction that would get this switched off. The
       same file has `.alpha{…}` and `class="alpha"`; a selector is a hook,
       not a promise, and flagging styling as a claim is noise. */
    const root = tree("0.1.0", {
      "site/index.html":
        "<style>.alpha{background:#f5a524} .alpha b{color:#ffc75c}</style>\n" +
        '<div class="alpha"><div class="wrap">Nothing is claimed here.</div></div>\n',
    });
    expect(run(root).code).toBe(0);
  });

  it("flags a sentence pointing at a banner the bump removes", () => {
    /**
     * Found by walking the whole cut instead of its pieces.
     *
     * I made the six prose edits myself and left *"the warning at the top of
     * this file is the guard"* in a file whose warning I had just deleted.
     * The gate named that line — it also says `@alpha` — and I repaired the
     * clause it named and not the one beside it. The six hand edits are not
     * six independent substitutions.
     */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\nA bare install resolves here; the warning at the top of\n" +
        "this file is the guard.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
  });

  it("does not flag the word `warning` used about anything else", () => {
    /**
     * The false-alarm direction, and the one that gets a check deleted.
     *
     * A mutation broadening the rule to any line containing "warning" or
     * "banner" passed every other case here — and a repository whose docs
     * mention warnings at all would then be unable to cut a release. The rule
     * matches a POINTER at the top of the file, not the word.
     */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\nThe daemon prints a warning when no model is configured,\n" +
        "and the banner on the devices page says the same thing.\n",
    });
    const { code, out } = run(root);
    expect(code, out).toBe(0);
  });

  it("leaves that sentence alone while the banner is still there", () => {
    /* At a prerelease the reference is TRUE, and a gate that flagged it would
       be demanding the removal of an accurate sentence. */
    const root = tree("0.1.0-alpha.103", {
      "README.md":
        "> **Alpha (`0.1.0-alpha.103`) — under active development.**\n\n" +
        "See the warning at the top of this file.\n",
    });
    expect(run(root).code).toBe(0);
  });

  it("leaves release-note history alone", () => {
    /**
     * `alpha.58` was an alpha permanently, and a README that stopped saying so
     * would be rewriting history to make a check pass. `bump-version.mjs`
     * draws this line first — *"README bodies are history too"* — and this
     * reader draws it the same way, so the two cannot disagree about which
     * lines are live.
     */
    const root = tree("0.1.0", {
      "README.md":
        "# byollm\n\n> **`alpha.58` broke everything.** Generate with\n" +
        "> `npx --package @byollm/server@alpha keygen`, then set the env var.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(0);
    /* The pass sentence gained a scope on 2026-09-18 — "no document IN THIS
       REPOSITORY" — because it was a claim about every document made by a
       reader of one tree. The subject of this case is the history rule, not
       the wording, so it asserts the pass rather than the old literal. */
    expect(out).toContain("claims otherwise");
  });

  it("is what the real repository looks like now the cut has landed", () => {
    /**
     * The case that makes this more than fixtures: the actual tree, with one
     * value changed to what the cut set.
     *
     * **It used to assert the opposite, and that was right until 2026-09-21.**
     * It read "is what the real repository would FAIL on today" and named
     * fourteen lines across nine documents — the work the flip had to do. The
     * cut did it, so the same case now asserts the tree is clean at a clean
     * version, and from here it is the regression guard: re-add an alpha claim
     * and this fires.
     *
     * A case pinned to "today" is only ever right until the day it describes.
     */
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-real-"));
    for (const path of ["README.md", "site", "packages"])
      cpSync(join(REPO, path), join(root, path), {
        recursive: true,
        filter: (src) =>
          !src.includes("node_modules") && !src.includes("/dist"),
      });
    writeFileSync(
      join(root, "packages", "protocol", "package.json"),
      JSON.stringify({ name: "@byollm/protocol", version: "0.1.0" }),
    );
    const { code, out } = run(root);
    expect(code, out).toBe(0);
    expect(out).toContain("no document IN THIS REPOSITORY claims otherwise");
  });
});

describe("the line numbers a reader will open — B253a", () => {
  /**
   * The rehearsal runs this gate against a BUMPED copy, and the bump deletes
   * eight banner lines. So every number below one was off by one against the
   * file a person actually has open, and all three README targets landed on a
   * blank line. The offset is one today and grows with every banner removed
   * above a survivor.
   *
   * `ALPHA_CLAIMS_NUMBER_FROM` names the tree whose numbers a reader will see.
   * Matched by line CONTENT rather than by arithmetic: an offset would have to
   * model what the bump does, and the two would drift the first time the bump
   * learned a new rule.
   */
  const withReference = (root, reference) => {
    const options = {
      encoding: "utf8",
      env: {
        ...process.env,
        ALPHA_CLAIMS_ROOT: root,
        ALPHA_CLAIMS_NUMBER_FROM: reference,
      },
    };
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [SCRIPT], options),
      };
    } catch (error) {
      return {
        code: error.status ?? -1,
        out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      };
    }
  };

  it("reports the number in the reference, not in the tree it read", () => {
    /* The bumped copy has the banner removed; the reference still has it, so
       the claim sits one line lower there. */
    const bumped = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    const reference = tree("0.1.0-alpha.102", {
      "README.md":
        "> **Alpha (`0.1.0-alpha.102`) — under active development.**\n\n" +
        "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    const { code, out } = withReference(bumped, reference);
    expect(code).toBe(1);
    expect(out).toContain("README.md:5");
    expect(out).not.toContain("README.md:3 ");
  });

  it("says so when the line cannot be found in the reference", () => {
    /* The bump rewrites the site's banner rather than deleting it, so its text
       differs between the trees. Marking it beats guessing: a number presented
       without a caveat is a number somebody trusts. */
    const bumped = tree("0.1.0", {
      "site/index.html": "<b>Alpha (0.1.0) — active</b>\n",
    });
    const reference = tree("0.1.0-alpha.102", {
      "site/index.html": "<b>Alpha (0.1.0-alpha.102) — active</b>\n",
    });
    const { code, out } = withReference(bumped, reference);
    expect(code).toBe(1);
    expect(out).toContain("(post-bump)");
  });

  it("is unchanged when no reference is given", () => {
    /* The gate is run directly by `verify` and by `tag.sh`, where the tree it
       reads IS the tree a reader opens. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    const { out } = run(root);
    expect(out).toContain("README.md:3");
    expect(out).not.toContain("post-bump");
  });
});

describe("at a prerelease", () => {
  it("now REFUSES the real repository if it is bumped back to a prerelease", () => {
    /**
     * This read "passes the real repository as it stands", because the tree
     * was an alpha and its documents warned. Both halves of that changed on
     * 2026-09-21: the version is clean and the warnings are gone.
     *
     * So the real tree at a prerelease version is refused now — and that is
     * the biconditional working, not a regression. A repository shipping
     * alphas with no warning is the same defect wearing the other face, which
     * is what the case below says with a fixture. Said here against the REAL
     * tree, because that is the one somebody would bump.
     */
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-back-"));
    for (const path of ["README.md", "site", "packages"])
      cpSync(join(REPO, path), join(root, path), {
        recursive: true,
        filter: (src) =>
          !src.includes("node_modules") && !src.includes("/dist"),
      });
    writeFileSync(
      join(root, "packages", "protocol", "package.json"),
      JSON.stringify({ name: "@byollm/protocol", version: "0.1.0-alpha.104" }),
    );
    const { code, out } = run(root);
    expect(code, out).toBe(1);
    /* The gate's own words for this direction, which name the defect rather
       than the version: "a prerelease whose docs have quietly stopped warning
       is the same defect as a release whose docs still do, pointing the other
       way." */
    expect(out).toContain("NO document says so");
  });

  it("refuses a prerelease whose documents have stopped warning", () => {
    /* The other direction, and the reason this is a biconditional. A check
       that only fired after the flip would never have been run before it —
       and a repository shipping alphas with no warning is the same defect
       wearing the other face. */
    const root = tree("0.1.0-alpha.103", {
      "README.md": "# byollm\n\nA perfectly calm README.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("NO document says so");
  });
});

describe("invoked through a symlinked path", () => {
  it("still runs, instead of exiting 0 having read nothing", () => {
    /**
     * The fail-open `rehearse-the-cut.mjs` found on its first run.
     *
     * `import.meta.url` RESOLVES symlinks; `process.argv[1]` does not. On
     * macOS `/var` is a symlink to `/private/var`, so this script invoked from
     * anywhere under `/tmp` compared two spellings of the same file, concluded
     * it was being imported, ran nothing and **exited 0** — a gate reporting
     * success having checked nothing, which is the shape every refusal in it
     * is written against.
     *
     * The case builds the same trap deliberately: a symlink to the scripts
     * directory, and the script invoked through it. Exit 0 alone would pass
     * this; the output is what proves it ran.
     */
    const dir = mkdtempSync(join(tmpdir(), "alpha-claims-link-"));
    const link = join(dir, "scripts");
    symlinkSync(dirname(SCRIPT), link, "dir");
    const viaLink = join(link, "alpha-claims-match-the-version.mjs");

    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nRun `npm install @byollm/protocol@alpha`.\n",
    });
    let out;
    let code = 0;
    try {
      out = execFileSync(process.execPath, [viaLink], {
        encoding: "utf8",
        env: { ...process.env, ALPHA_CLAIMS_ROOT: root },
      });
    } catch (error) {
      code = error.status ?? -1;
      out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    expect(code, "the gate ran nothing and called it success").toBe(1);
    expect(out).toContain("still say alpha");
  });
});

describe("the reader refuses rather than passing nothing", () => {
  it("refuses a tree with no protocol manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-empty-"));
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain("packages/protocol/package.json");
  });

  it("refuses a tree with no documents at all", () => {
    /* Zero documents satisfies "no document claims alpha" perfectly, which is
       the fail-open this repository has shipped before. */
    const root = tree("0.1.0", {});
    const { code, out } = run(root);
    expect(code).toBe(2);
    expect(out).toContain("found no documents");
  });
});

describe("the live-versus-history rule, on text the repository does not contain", () => {
  /* The rules above are only ever exercised by documents that satisfy them.
     These are shapes nobody has written, driven through the real script. */

  it("counts the banner even though it is a blockquote", () => {
    const root = tree("0.1.0", { "README.md": BANNER });
    expect(run(root).code).toBe(1);
  });

  it("does not count a quoted install line", () => {
    const root = tree("0.1.0", {
      "README.md": "> install `@byollm/server@alpha` back then\n",
    });
    expect(run(root).code).toBe(0);
  });

  it("counts an unquoted one, and reports its line", () => {
    const root = tree("0.1.0", {
      "README.md": "one\ntwo\n`npm i @byollm/server@alpha`\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("README.md:3");
  });

  it("does not count a version string that merely contains the word", () => {
    /* `0.1.0-alpha.102` appears on every release-note heading and in every
       lockfile and is not an instruction. `@alpha` is the dist-tag;
       `alpha.102` is a version. Matching the word alone would make this
       reader useless on the day it matters. */
    const root = tree("0.1.0", {
      "README.md": "Released 0.1.0-alpha.102 on a Tuesday.\n",
    });
    expect(run(root).code).toBe(0);
  });
});

describe("the paths it hands a person during a cut", () => {
  /**
   * Forward slashes, on every platform.
   *
   * This list is the one somebody opens files from **while cutting a
   * release**, and on windows-latest it read `packages\server\README.md` —
   * which is not what git prints, not what a GitHub link uses, and not what
   * the READMEs themselves contain. CI caught it: three cases in this file
   * were asserting `packages/server/README.md` and failing on one platform
   * only.
   *
   * **Locally this case cannot fail**, because `sep` is already `/` here — a
   * mutation removing the normalisation survives on macOS and dies on
   * Windows. It is written anyway, as an invariant about the OUTPUT rather
   * than about the platform, so the requirement has a name instead of living
   * in whichever CI job happens to notice.
   */
  it("never reports a backslash-separated path", () => {
    const root = tree("0.1.0", {
      "packages/server/README.md": "# server\n\n`@byollm/server@alpha`\n",
      "site/index.html": '<meta content="Alpha software">\n',
    });
    const { out } = run(root);
    const paths = [...out.matchAll(/^\s{2}(\S+):\d+/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(
      paths.length,
      "no file:line rows were read — the report's shape moved",
    ).toBeGreaterThan(0);
    expect(
      paths.filter((path) => path.includes("\\")),
      "a path in the hand-edit list uses the platform separator; the reader's git, GitHub and READMEs all use /",
    ).toEqual([]);
  });

  it("uses them in the refusal too, not only in the findings", () => {
    /**
     * The second site, and the reason this file now says so out loud: the
     * first pass normalised the findings list and left the no-manifest
     * refusal reporting `packages\protocol\package.json`. CI went red again
     * one commit later, on the same defect in the same file.
     *
     * One path fixed is not fixed — and here it was not even one FILE fixed.
     * Both spellings go through one helper now, and this asserts the site the
     * first attempt missed.
     */
    const root = mkdtempSync(join(tmpdir(), "alpha-claims-nomanifest-"));
    const { out } = run(root);
    expect(out).toMatch(/no packages\/protocol\/package\.json/u);
    expect(out).not.toMatch(/packages\\protocol/u);
  });
});

describe("the hand-edit list shows why each line is in it", () => {
  /**
   * The list is what somebody works from **during a cut**, and it used to
   * head-truncate at 96 characters. Three of the six real hits sit past that:
   * the README's `status-alpha` badge is at ~180, and the site's two `<meta>`
   * descriptions bury "Alpha software, under active development." at the end
   * of a sentence about something else.
   *
   * So a person opened `README.md:351`, saw an npm badge, and had no reason it
   * was listed — in a ceremony that cannot be undone. A list nobody can act on
   * without hunting is a list they start skimming.
   */
  it("shows the matched word even when it is far along a long line", () => {
    const root = tree("0.1.0", {
      "README.md": `# x\n\n${"padding text that goes on and on. ".repeat(6)}status-alpha-orange badge\n`,
    });
    const { out } = run(root);
    expect(out).toContain("status-alpha");
    /* And says it is an excerpt, so a fragment is not read as the line. */
    expect(out).toMatch(/…/u);
  });

  it("centres on the alpha word, not on where the rule began", () => {
    /**
     * `META` matches from `content="`, which on a real description tag is the
     * start of a long sentence about something else. Centring there showed
     * everything except the word that put the line in the list.
     */
    const root = tree("0.1.0", {
      "site/index.html": `<meta name="description" content="${"a long sentence about the product. ".repeat(4)}Alpha software.">\n`,
    });
    const { out } = run(root);
    expect(out).toContain("Alpha software");
  });

  it("names the rule that fired", () => {
    const root = tree("0.1.0", {
      "README.md": "# x\n\nAsk for `@alpha` explicitly.\n",
    });
    expect(run(root).out).toContain("[@alpha]");
  });

  it("does not mark an excerpt that is the whole line", () => {
    /* An ellipsis on a short line would be a lie about what was cut. */
    const root = tree("0.1.0", { "README.md": "# x\n\n`@alpha`\n" });
    const line =
      run(root)
        .out.split("\n")
        .find((l) => l.includes("README.md:")) ?? "";
    expect(line).not.toContain("…");
  });
});

describe("the warning body the bump leaves standing", () => {
  /**
   * B269, and it is the gate's own failure shape one paragraph over.
   *
   * `bump-version.mjs` retires ONE line — `/^\s*>\s*\*\*Alpha \(/` — and every
   * README's banner is a multi-line `> [!WARNING]` block. Bumping to `0.1.0`
   * left, on the front of the npm page for four packages and the top of the
   * root README, on the day the release note says the wire is locked:
   *
   *     > [!WARNING]
   *     >
   *     > The protocol is v0 and **will** change without a deprecation path,
   *     > this has never run outside its own test suite, and nothing here has
   *     > production miles. Read it, take the ideas, tell us what's wrong —
   *     > but don't put it in front of your users.
   *
   * The gate said nothing. `CLAIM` is `@alpha|status-alpha`, so after
   * `dropAlphaTag` it pointed a human at line 13 of that block — *"Ask for
   * `@alpha` explicitly"* — and named none of the eight above it. Fixing the
   * clause it named and not the one beside it is precisely what
   * `POINTS_AT_THE_BANNER` exists to stop, arriving in the rule that stops it.
   *
   * ## These fixtures are the real block, run through the real bump
   *
   * Not a hand-written approximation of what survives. `bump-version.mjs` is
   * executed over the fixture and the gate reads what it produced, because the
   * question is what those two scripts do to each other and a fixture I
   * trimmed myself would be asserting my own belief about the first one.
   */

  /** The real README banner, as the four package READMEs carry it. */
  const banner = (pkg) =>
    "> [!WARNING]\n" +
    "> **Alpha (`0.1.0-alpha.102`) — under active development. Don't use this yet.**\n" +
    ">\n" +
    `> Install it deliberately: \`npm install ${pkg}@alpha\`.\n` +
    ">\n" +
    "> The protocol is v0 and **will** change without a deprecation path, this has\n" +
    "> never run outside its own test suite, and nothing here has production miles.\n" +
    "> Read it, take the ideas, tell us what's wrong — but don't put it in front of\n" +
    "> your users.\n" +
    ">\n" +
    "> **`alpha.15` is a breaking wire change** — daemons and relays, not app\n" +
    "> authors. Every package moves together. It is the release that first said\n" +
    "> don't use this yet, and it has no production miles either.\n" +
    "\n" +
    `# ${pkg}\n`;

  /** The fixture, bumped by the real bumper, then read by the real gate. */
  const afterTheBump = (files) => {
    const root = tree("0.1.0-alpha.102", files);
    /* Pretty-printed, because `bump-version.mjs` rewrites the version line and
       finds it with `/^\s*"version"\s*:/` — a manifest on one line has no such
       line and the bump silently leaves the version alone, which is how the
       first draft of these cases ran the gate against an unbumped tree and
       asserted about a prerelease. No real package.json is one line. */
    writeFileSync(
      join(root, "packages", "protocol", "package.json"),
      `${JSON.stringify(
        { name: "@byollm/protocol", version: "0.1.0-alpha.102" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./bump-version.mjs", import.meta.url)), "0.1.0"],
      { cwd: root, encoding: "utf8" },
    );
    return { root, ...run(root) };
  };

  it("leaves the body standing — the fixture is the real defect", () => {
    /* The control on every case below. If the bumper ever grew a rule that
       removed the whole block, these would be asserting about a defect that no
       longer exists, and they would all still pass. */
    const { root } = afterTheBump({
      "packages/protocol/README.md": banner("@byollm/protocol"),
    });
    const after = readFileSync(
      join(root, "packages", "protocol", "README.md"),
      "utf8",
    );
    expect(after).not.toMatch(/Don't use this yet/u);
    expect(after).toContain("without a deprecation path");
    /* Not "in front of your users" — the real READMEs wrap that phrase across
       two lines, and asserting it here would be asserting my own idea of the
       fixture rather than the shape the packages carry. */
    expect(after).toContain("production miles");
  });

  it("is named, line by line", () => {
    const { code, out } = afterTheBump({
      "packages/protocol/README.md": banner("@byollm/protocol"),
    });
    expect(code).toBe(1);
    /**
     * Matched as a FINDING ROW — `file:line  [rule]` — and not as the words
     * anywhere in the output.
     *
     * The gate's own explanation names its rules in prose, so a mutation
     * deleting the rule left the phrase standing in the paragraph below the
     * list and this passed. Fifth time in one afternoon that an assertion
     * matched the sentence explaining a thing rather than the thing.
     */
    expect(out).toMatch(/README\.md:1\s+\[warning with no warning\]/u);
    expect(out).toMatch(
      /README\.md:\d+\s+\[pre-release claim\].*deprecation path/u,
    );
    expect(out).toMatch(
      /README\.md:\d+\s+\[pre-release claim\].*production miles/u,
    );
  });

  it("names a header whose body somebody reworded", () => {
    /**
     * The second wall. The structural rule is *"a `> [!WARNING]` whose next
     * line is a bare `>`"* — a warning with its warning removed — and it holds
     * whatever the sentences say, which is why relay's *"has never run
     * anywhere but a test"* is caught without anybody having thought of that
     * sentence in advance.
     */
    const { code, out } = afterTheBump({
      /* The manifest is not decoration: `bump-version.mjs` walks
         `packages/<d>/README.md` only where `packages/<d>/package.json`
         exists, so a fixture without one is a README the bump never touches —
         and this case would then be asserting about an unbumped file. */
      "packages/relay/package.json":
        '{\n  "name": "@byollm/relay",\n  "version": "0.1.0-alpha.102"\n}\n',
      "packages/relay/README.md":
        "> [!WARNING]\n" +
        "> **Alpha (`0.1.0-alpha.102`) — under active development. Don't use this yet.**\n" +
        ">\n" +
        "> This is a walking skeleton. It keeps its state in memory and has\n" +
        "> never run anywhere but a test.\n" +
        "\n# @byollm/relay\n",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/relay\/README\.md:1\s+\[warning with no warning\]/u);
    expect(out).toMatch(
      /relay\/README\.md:\d+\s+\[pre-release claim\].*walking skeleton/u,
    );
  });

  it("says nothing about the release history under the same blockquote", () => {
    /**
     * The constraint that makes this hard, and the reason every `>` line used
     * to be history. The warning and the changelog are **one** blockquote —
     * no blank line between them, so markdown joins them and the root
     * README's runs past line 300. A rule that treated the whole blockquote as
     * live would report every past release's *"breaking wire change"* as a
     * claim about this one, on every cut forever.
     */
    const { out } = afterTheBump({
      "packages/protocol/README.md": banner("@byollm/protocol"),
    });
    /* The history line in `banner` deliberately carries two phrases the live
       rules match — "don't use this yet" and "production miles" — so this case
       fails if the region's end moves. Without them a mutation removing
       `RELEASE_ENTRY` from the boundary passed: the history was swallowed and
       nothing in it happened to match, which is a case asserting about its own
       fixture rather than about the boundary. */
    expect(out).not.toMatch(/breaking wire change/u);
    expect(out).not.toMatch(/it has no production miles either/u);
  });

  it("says nothing about prose that is still true after the cut", () => {
    /**
     * `README.md:577` says *"it will change without a deprecation path"* about
     * what v0 means, outside any warning block, and that stays true at 0.1.0 —
     * 0.x is v0. Reporting it would be reporting a true sentence in the list
     * somebody works from during a ceremony that cannot be undone, and that is
     * how a gate gets switched off.
     */
    const { out } = afterTheBump({
      "packages/protocol/README.md": "# @byollm/protocol\n",
      "README.md":
        "# byollm\n\nThe protocol is at v0, and v0 means what it says: it\n" +
        "will change without a deprecation path.\n",
    });
    expect(out).not.toMatch(/deprecation path/u);
  });

  it("leaves a warning that is not about the release alone", () => {
    /**
     * The false-alarm direction, and a mutation found it missing: reporting
     * every `> [!WARNING]` header rather than one whose body was removed
     * passed every case above.
     *
     * A README may warn about something permanent — this command deletes your
     * data, this store is not durable — and that warning is still true at
     * `0.1.0`. Naming it would tell whoever runs the cut to delete a true
     * warning, in the list they work from during a ceremony that cannot be
     * undone. The signal is a header standing over NOTHING, which is what the
     * bump leaves behind; a header with a body is a warning somebody meant.
     */
    const { code, out } = afterTheBump({
      "packages/protocol/package.json":
        '{\n  "name": "@byollm/protocol",\n  "version": "0.1.0-alpha.102"\n}\n',
      "packages/protocol/README.md":
        "> [!WARNING]\n" +
        "> `MemoryStore` keeps everything in memory. Restarting loses every job\n" +
        "> that has not been collected.\n" +
        "\n# @byollm/protocol\n",
    });
    expect(code).toBe(0);
    expect(out).not.toMatch(/warning with no warning/u);
  });

  it("no longer claims the list is everything", () => {
    /**
     * The sentence this gate printed while six warning bodies stood behind it:
     * *"These are the HAND EDITS, and they are all that is left."* A gate that
     * overstates its coverage is worse than none, because the person who
     * trusts it stops looking — the same finding `rehearse-the-cut` was
     * written for, in the file that gate reports to.
     */
    const { out } = afterTheBump({
      "packages/protocol/README.md": banner("@byollm/protocol"),
    });
    expect(out).not.toMatch(/they are all that is left/u);
    expect(out).toMatch(/not the same as\s*\n?everything/u);
  });
});

describe("the hand edits this gate cannot reach — B284", () => {
  /**
   * CW's ask of 2026-09-18: *"add B284's three lines to the cut's printed
   * refusals so they cannot survive it silently."*
   *
   * Every rule in this file walks THIS repository. The Terms that say "It is
   * alpha software" are in `byollm-cloud-web`, and they go false at the cut
   * exactly like the sentences these rules refuse — with nothing to stop them,
   * because nothing here can read that tree.
   */

  it("names them when it refuses", () => {
    const root = tree("0.1.0", { "README.md": `# byollm\n\n${BANNER}` });
    const { code, out } = run(root);
    expect(code).toBe(1);
    /**
     * B341: this named `B284` and `terms/page.tsx` literally, and both were
     * true in September and done by 09-22. What the case is FOR is that a
     * refusal does not swallow the list, so that is what it asks — of
     * whatever the list holds, including nothing.
     */
    if (CROSS_REPO.length > 0) {
      expect(out).toContain("HAND EDITS THIS GATE CANNOT SEE");
      for (const row of CROSS_REPO) expect(out).toContain(row.row);
    } else {
      expect(out).toContain("No hand edits outstanding");
    }
  });

  it("names them when it PASSES, which is the path that would hide them", () => {
    /**
     * The case that matters, and the reason the notice is not simply appended
     * to the refusal text.
     *
     * The in-repo claims get fixed first — that is the whole point of the
     * refusal — and the run after that one is green. If the list printed only
     * on failure, the last thing anybody saw before tagging would be a clean
     * gate, and the Terms would ship saying the software is alpha on the day
     * it stopped being. **A green run is exactly when an unreadable surface
     * needs naming.**
     */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nNothing to see.\n",
    });
    const { code, out } = run(root);
    expect(code).toBe(0);
    /* The path that would hide them, which is the whole point of this case:
       a green run must still say what it could not check. With entries that
       is the heading; with none it is the sentence saying there are none. */
    if (CROSS_REPO.length > 0) {
      expect(out).toContain("HAND EDITS THIS GATE CANNOT SEE");
      for (const row of CROSS_REPO) expect(out).toContain(row.row);
    } else {
      expect(out).toContain("No hand edits outstanding");
    }
  });

  it("stops claiming that NO document says otherwise", () => {
    /**
     * It said *"no document claims otherwise"* — a statement about every
     * document, made by a reader of one repository. That is the overclaim B269
     * already corrected once in this file, when it announced completeness for
     * a release while six warning bodies stood behind it unnamed.
     *
     * Asserted by absence as well as presence, because the new sentence
     * contains the old one as a substring and a partial edit would satisfy a
     * `toContain` alone.
     */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nNothing to see.\n",
    });
    const { out } = run(root);
    expect(out).toContain("IN THIS REPOSITORY");
    expect(out).not.toMatch(/prerelease and no document claims otherwise/u);
  });

  it("says out loud that it has not checked them", () => {
    /* The difference between a list and a verdict. A reader who took these
       for findings would go looking for what turned them up, and a reader who
       took them for checked would trust a green run that never read them. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nNothing to see.\n",
    });
    const { out } = run(root);
    if (CROSS_REPO.length > 0) {
      expect(out).toContain("These are not findings");
      expect(out).toContain("survive a green run");
    } else {
      /* The same honesty with nothing to list: it still says it reads this
         repository only, and hands over the command for the other half
         rather than a date that ages silently. */
      expect(out).toContain("reads this repository only");
      expect(out).toMatch(/git -C \.\.\/byollm-cloud-web grep/u);
    }
  });

  it("never prints a heading with nothing under it", () => {
    /**
     * **This asked for at least two entries until 2026-09-22 (B341), and the
     * number was the wrong expression of a right idea.**
     *
     * Its reason was the fail-open: an empty list printing a heading and
     * nothing beneath it reads as *"there is nothing we cannot see"*. True,
     * and it made the list unable to SHRINK — so when B284's Terms rewrite
     * landed in `byollm-cloud-web b44e02c` and B279's sentence came out of
     * this repository, both rows stayed, and a passing gate handed the
     * operator two jobs for shipped work on every release. A list with stale
     * rows is a list people stop reading.
     *
     * So the invariant is stated directly instead of proxied through a count:
     * either rows are listed, or the emptiness is a sentence. Never a heading
     * over nothing.
     */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nNothing to see.\n",
    });
    const { out } = run(root);
    const heading = out.indexOf("HAND EDITS THIS GATE CANNOT SEE");
    if (heading === -1) {
      expect(
        out,
        "no list and no sentence — a reader cannot tell whether there is " +
          "nothing outstanding or the gate forgot to print it",
      ).toContain("No hand edits outstanding");
      return;
    }
    const rows = [...out.slice(heading).matchAll(/^ {2}B\d+ {2}/gmu)].length;
    expect(
      rows,
      "the heading is printed with no rows under it, which reads as " +
        "'there is nothing we cannot see'",
    ).toBeGreaterThan(0);
  });
});

describe("the npm page's own headline — B293", () => {
  /**
   * npm renders `description` at the top of a package's page, above the
   * README and in larger type, and every rule in this file read a DOCUMENT.
   * So `byollm` and `@byollm/protocol` would have reached `0.1.0` still
   * saying *"ALPHA: under active development"* on two public pages, refused
   * by nothing.
   *
   * Third appearance of one blind spot: the link checker read no manifests
   * (B281), the alpha rules could not see the docs site (B283), and the alpha
   * rules could not see the manifests either.
   */
  const manifest = (description) =>
    JSON.stringify({ name: "@x/a", version: "0.1.0", description }, null, 2);

  it("lists a description that still says alpha", () => {
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nnothing to see\n",
      "packages/a/package.json": manifest(
        "Bring Your Own LLM. ALPHA: under active development.",
      ),
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain("packages/a/package.json");
    expect(out).toContain("npm description");
  });

  it("leaves a description that does not", () => {
    /* The control: a manifest is read, and reading one is not the same as
       reporting it. Without this the rule could be "every manifest is a
       finding" and the case above would not notice. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nnothing to see\n",
      "packages/a/package.json": manifest(
        "Framework-agnostic protocol handlers and a reference store.",
      ),
    });
    expect(run(root).code).toBe(0);
  });

  it("does not read a dependency version as a claim", () => {
    /**
     * The false-alarm direction, and the reason this reads the description
     * rather than the file. Every manifest in a real tree carries
     * `0.1.0-alpha.102` in `dependencies`, so a whole-file rule would report
     * six findings on a correct tree and be switched off within a day.
     */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nnothing to see\n",
      "packages/a/package.json": JSON.stringify(
        {
          name: "@x/a",
          version: "0.1.0",
          description: "A reference store.",
          dependencies: { "@byollm/protocol": "0.1.0-alpha.102" },
        },
        null,
        2,
      ),
    });
    expect(run(root).code).toBe(0);
  });

  it("leaves a private manifest alone, because npm renders nothing", () => {
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nnothing to see\n",
      "packages/a/package.json": JSON.stringify(
        { name: "@x/a", private: true, description: "ALPHA: do not use." },
        null,
        2,
      ),
    });
    expect(run(root).code).toBe(0);
  });

  it("points at the line a person will open", () => {
    /* The list is what somebody works from during the cut. A finding naming
       the file and not the line sends them scrolling through JSON. */
    const root = tree("0.1.0", {
      "README.md": "# byollm\n\nnothing to see\n",
      "packages/a/package.json": manifest("ALPHA: under active development."),
    });
    const { out } = run(root);
    expect(out).toMatch(/packages\/a\/package\.json:\d+/u);
  });
});

describe("the hand-edit list does not outlive its jobs — B341", () => {
  /**
   * Both entries were still being printed after both were done: B284's Terms
   * rewrite had landed in `byollm-cloud-web b44e02c` and B279's sentence had
   * come out of this repository's READMEs, in the same cut. So a PASSING gate
   * handed the operator two jobs for shipped work, every release.
   *
   * That is worse than printing nothing. A list with stale rows is a list
   * people stop reading, and then the row that matters arrives in a list
   * nobody reads.
   *
   * A cross-repo row genuinely cannot be checked here — the file's own
   * reasoning, which stands: a checker that reads a sibling working tree
   * reports on whatever happens to be checked out there. A row about THIS
   * repository has no such excuse.
   */
  it("holds an in-repo row to text that is still there", async () => {
    const { CROSS_REPO } = await import("./alpha-claims-match-the-version.mjs");
    const root = fileURLToPath(new URL("..", import.meta.url));

    const mine = CROSS_REPO.filter(
      (row) =>
        row.where.startsWith("byollm ") || row.where.startsWith("byollm\t"),
    );

    for (const row of mine) {
      expect(
        row.find,
        `${row.row} names this repository, so it must carry a \`find\` — the ` +
          "text that proves the edit has NOT been made. Without one the row " +
          "cannot be retired except by somebody remembering, which is how " +
          "B279 and B284 were still being printed after both were done",
      ).toBeTruthy();

      const hits = execFileSync(
        "git",
        ["grep", "-l", "--fixed-strings", row.find],
        { cwd: root, encoding: "utf8" },
      ).trim();
      expect(
        hits,
        `${row.row} says the edit is outstanding, but its own text is gone ` +
          "from this repository — the job is done and the row should be " +
          "deleted",
      ).not.toBe("");
    }
  });

  it("says so out loud when there is nothing outstanding", () => {
    /* "No list" and "a list I forgot to print" look identical on a terminal,
       so the empty case is a sentence rather than an absence — and it carries
       the command for the half this gate cannot reach, instead of a date. */
    const source = readFileSync(
      fileURLToPath(
        new URL("./alpha-claims-match-the-version.mjs", import.meta.url),
      ),
      "utf8",
    );
    expect(source).toContain("No hand edits outstanding");
    expect(source).toMatch(/git -C \.\.\/byollm-cloud-web grep/u);
  });
});
