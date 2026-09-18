#!/usr/bin/env node
/**
 * The docs stop saying "alpha" when the version stops being one — B222.
 *
 * The row's parenthetical is the whole rule: *"Alpha warning comes OUT of the
 * README in the same cut (a truth line must not outlive the truth)."* This is
 * that sentence as a gate, and it exists because the cut would otherwise have
 * shipped the opposite.
 *
 * ## What `bump-version.mjs` would have done at the flip
 *
 * It rewrites the version INSIDE the banner and never removes the banner. So
 * `bump-version.mjs 0.1.0` produces, on eight READMEs and the site:
 *
 *     > **Alpha (`0.1.0`) — under active development. Don't use this yet.**
 *
 * A sentence that contradicts itself, on the most-read files in the
 * repository, in the commit that makes it public.
 *
 * ## And the banner is the smaller half
 *
 * The docs carry live INSTRUCTIONS pinned to the `alpha` dist-tag:
 * `npm install @byollm/protocol@alpha`, `npx --package @byollm/server@alpha
 * keygen`, *"Ask for `@alpha` explicitly"*. After the flip the workflow moves
 * `latest`; nothing moves `alpha`. So every one of those keeps resolving to
 * the last prerelease — **a reader following our own quickstart would install
 * an older package than the one we just locked**, and the failure would look
 * like their mistake.
 *
 * That is a worse class than a stale adjective, and it is the reason this
 * checks instructions rather than the word.
 *
 * ## Live versus history, which is the only hard part
 *
 * READMEs carry release notes for past versions, and those SHOULD go on saying
 * alpha — `alpha.58` was an alpha, permanently. `bump-version.mjs` draws the
 * same line and says why: *"README bodies are history too."*
 *
 * The rule here: a `>` blockquote is history, except the banner itself, which
 * is a blockquote and is live. Everything outside a blockquote is live. That
 * is decidable, it matches what the bumper already believes, and it puts
 * `README.md:327` (a 2026-08 breaking note quoting the keygen command of its
 * day) on the history side while `README.md:407` — the same command, in the
 * current quickstart — stays live.
 *
 * ## Both directions
 *
 * At a prerelease, the claims must be PRESENT: a repository that had quietly
 * lost its alpha warning while still shipping alphas is the same defect
 * pointing the other way, and a check that only fires after the flip would
 * never have been run before it.
 *
 * `ALPHA_CLAIMS_ROOT` moves where it reads, for the fixtures in
 * `alpha-claims-match-the-version.test.mjs`. It changes where it looks, never
 * what it asks.
 *
 * `ALPHA_CLAIMS_NUMBER_FROM` names a second tree whose files supply the LINE
 * NUMBERS — B253a. `rehearse-the-cut.mjs` runs this against a bumped copy, and
 * the bump deletes eight banner lines, so every number below them was off by
 * one against the file a person actually has open. All three README targets
 * landed on a blank line, and the offset grows with every banner removed above
 * a survivor.
 *
 * A list whose whole purpose is *go and edit exactly these* has to address the
 * file the reader opens. Matched by line CONTENT rather than by arithmetic: an
 * offset would have to model what the bump does, and the two would drift the
 * first time the bump learned a new rule. A line that cannot be found in the
 * reference says so instead of guessing.
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A path as this project writes paths: relative, forward slashes, everywhere.
 *
 * `relative` gives `packages\\server\\README.md` on Windows, and these strings
 * are the list somebody opens files from **while cutting a release** — while
 * git, GitHub and the READMEs themselves all use `/`.
 *
 * **One helper because fixing one site is not fixing it.** The first pass
 * normalised the findings and left the no-manifest refusal alone, and CI
 * failed again on the second site a commit later. Both go through here now,
 * and so does the third.
 */
const repoPath = (root, path) => relative(root, path).split(sep).join("/");

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The banners `bump-version.mjs` rewrites, matched the way it matches them.
 *
 * TWO shapes, and the second was missing from the first version of this file —
 * found by B252, four hours later, reading the very document this gate was
 * written to protect. The markdown banner is what eight READMEs carry; the
 * HTML one is the orange bar across the top of `byollm.dev`, which is the
 * alpha warning the most people actually see. `bump-version.mjs` has always
 * known about both; this reader knew about one, because markdown READMEs were
 * the only input it was ever run against.
 *
 * Standing instruction 0's second companion, arriving in the check that the
 * companion was written beside.
 */
const BANNER = /^\s*>\s*\*\*Alpha \(|<b>Alpha \(/i;

/**
 * A live claim that this is alpha software, or an instruction pinned to the
 * `alpha` dist-tag.
 *
 * `@alpha` catches every install and `npx` line. `status-alpha` is the README
 * badge. `Alpha software` is the site's own words in its meta description —
 * the one place a claim reaches somebody who never opens the page.
 */
const CLAIM = /@alpha\b|status-alpha/i;

/**
 * A claim in an HTML attribute a reader never opens the page to see.
 *
 * `og:description` and `twitter:description` are what a link preview shows, so
 * they reach people who never arrive. Matched inside `content="…"` only —
 * **not** anywhere the word appears — because `site/index.html` also contains
 * `.alpha{…}` and `class="alpha"`, which are a CSS selector and a hook. A
 * class name is not a claim, and a reader that flagged them would be reporting
 * styling as a promise and would be switched off for it.
 */
const META = /content="[^"]*\bAlpha\b[^"]*"/;

/**
 * A sentence that points at the banner — and the bump deletes the banner.
 *
 * Found by walking the whole cut rather than its pieces: I made the six prose
 * edits myself, and left *"the warning at the top of this file is the guard"*
 * standing in a file whose warning I had just removed. The gate had pointed me
 * at that very line — it also says `@alpha` — and I fixed the clause it named
 * and not the one beside it.
 *
 * So the six hand edits are not six independent substitutions: two of them
 * carry a second dependency the gate did not name. It names it now.
 *
 * Phrase-matched, and that is the limit: a reference worded some other way
 * escapes. The two that exist are worded these ways, and a rule that catches
 * what people actually wrote beats one that catches nothing while claiming
 * everything — the argument `one-way-to-say-a-gigabyte` makes about its own
 * narrowness.
 */
const POINTS_AT_THE_BANNER =
  /\b(?:the )?(?:warning|banner)\s+at\s+the\s+top\b|\bsee the warning\b/i;

/**
 * The bump takes the banner LINE and leaves the warning BODY — B269.
 *
 * `RETIRED_AT_RELEASE` is one shape, `/^\s*>\s*\*\*Alpha \(/`, and every
 * README's banner is a multi-line `> [!WARNING]` block. Bumping to `0.1.0`
 * deletes line 2 and leaves lines 3-13 exactly where they were, so the front
 * of the npm page for protocol, server, daemon and conformance would have
 * read *"will change without a deprecation path … don't put it in front of
 * your users"* on the day the release note says the wire is locked.
 *
 * **Nothing named it.** `CLAIM` is `@alpha|status-alpha`, and after
 * `dropAlphaTag` the only `@alpha` left in those blocks is the line telling
 * you to ask for the tag — so this gate pointed a human at one line of the
 * block and said nothing about the eight above it. That is the failure
 * `POINTS_AT_THE_BANNER`'s own docstring describes, one paragraph over: *"I
 * fixed the clause it named and not the one beside it."*
 *
 * ## Why this is structural rather than a phrase list
 *
 * Every one of the six surviving blocks has the same shape after the bump: a
 * `> [!WARNING]` header whose next line is a bare `>`. **A warning with its
 * warning removed** — which is both the evidence and the whole finding, needs
 * no vocabulary to stay current, and catches relay's *"has never run anywhere
 * but a test"* without anybody having thought of that sentence in advance.
 *
 * The phrases below are the second wall, for a block whose header somebody
 * reworks while leaving the body. Narrow on purpose, and scoped to the
 * warning region: `README.md:577` says *"it will change without a deprecation
 * path"* in ordinary prose about what v0 means, which stays true after the
 * cut. Reporting it would be reporting a true sentence, and that is how a
 * gate gets switched off.
 */
const PRERELEASE_CLAIM =
  /\bdon't use this yet\b|\bwithout a deprecation path\b|\bin front of your users\b|\bproduction miles\b|\bnever run (?:outside|anywhere)\b|\bwalking skeleton\b/i;

/** A GitHub alert header: `> [!WARNING]`, `[!CAUTION]`, `[!IMPORTANT]`. */
const WARNING_OPENS = /^\s*>\s*\[!(?:WARNING|CAUTION|IMPORTANT)\]\s*$/i;

/**
 * A release entry, which ends the live region and begins the history.
 *
 * The warning and the changelog are **one blockquote** — there is no blank
 * line between them, so markdown joins them and the root README's runs to line
 * 340. "Where the blockquote ends" therefore cannot delimit the warning, which
 * is exactly why every `>` line was treated as history in the first place.
 *
 * Every entry opens `> **`alpha.15` is …` — bold, then a code span. Verified
 * against all six documents before being relied on: the first such line is 23,
 * 8, 15, 15, 15 and 15, and in each the warning is entirely above it.
 */
const RELEASE_ENTRY = /^\s*>\s*\*\*`/;

/** A blockquote line with nothing in it — `>` and no more. */
const BLANK_QUOTE = /^\s*>\s*$/;

/**
 * An alpha claim in the one string npm renders above the README — B293.
 *
 * Every rule above reads a DOCUMENT. npm puts `description` at the top of a
 * package's page, in larger type than anything in the README, and this gate
 * never looked at it — so `byollm` and `@byollm/protocol` would have gone to
 * `0.1.0` still saying *"ALPHA: under active development"* on two public
 * pages, refused by nothing.
 *
 * Third time this blind spot has appeared: the link checker read no manifests
 * (B281), the alpha rules could not see the docs site (B283), and now the
 * alpha rules cannot see the manifests either. The surface is wider than the
 * documents in all three.
 *
 * **Scoped to the description and to nothing else in the file.** A manifest
 * scanned as text matches `0.1.0-alpha.102` in every `dependencies` block, so
 * a whole-file rule would report six false hits on a correct tree and be
 * switched off within a day. Measured: on this tree the rule fires on exactly
 * two descriptions, which are the two that say it.
 */
const DESCRIPTION_CLAIM =
  /\balpha\b|\bunder active development\b|\bnot for production\b/i;

/** Publishable manifests, whose `description` npm renders. */
const manifestClaims = (root) => {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  const found = [];
  for (const name of readdirSync(packages).sort()) {
    const file = join(packages, name, "package.json");
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, "utf8");
    /* A manifest that cannot be parsed is not a manifest with no claims. */
    const json = JSON.parse(raw);
    if (json.private === true) continue;
    if (typeof json.description !== "string") continue;
    const hit = DESCRIPTION_CLAIM.exec(json.description);
    if (hit === null) continue;
    found.push({
      file,
      line:
        raw.split("\n").findIndex((row) => row.includes('"description"')) + 1,
      rule: "npm description",
      text: json.description,
      at: hit.index,
    });
  }
  return found;
};

/** Every document a reader meets, not counting what is not published. */
const documents = (root) => {
  const found = [];
  const packages = join(root, "packages");
  if (existsSync(packages))
    for (const name of readdirSync(packages).sort()) {
      const readme = join(packages, name, "README.md");
      if (existsSync(readme)) found.push(readme);
    }
  for (const path of [
    join(root, "README.md"),
    join(root, "site", "index.html"),
  ])
    if (existsSync(path)) found.push(path);
  return found;
};

/**
 * Lines that claim alpha and are not history.
 *
 * Not exported, and the cases reach it through the script's exit code with
 * fixture documents — the shape `bump-version.test.mjs` takes, which is the
 * shape this directory takes. The rules still get run against text the
 * repository does not contain; they get run the long way round, through the
 * thing that actually ships.
 */
const liveClaims = (text) => {
  const hits = [];
  const lines = text.split("\n");

  /**
   * Which blockquote lines are a LIVE warning rather than quoted history.
   *
   * Every `>` line was history before B269, and that is why the surviving
   * warning body was invisible: it is blockquote from end to end. The region
   * runs from a `> [!WARNING]` header to the first release entry or the first
   * line that leaves the blockquote — see `RELEASE_ENTRY` for why the
   * blockquote's own end cannot be the boundary.
   */
  const live = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!WARNING_OPENS.test(lines[i] ?? "")) continue;
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      if (j > i && (RELEASE_ENTRY.test(line) || !/^\s*>/.test(line))) break;
      live.add(j);
    }
  }

  lines.forEach((line, at) => {
    const isBanner = BANNER.test(line);
    const isHistory = /^\s*>/.test(line) && !isBanner && !live.has(at);
    if (isHistory) return;

    /* A warning whose warning was removed: the header, then a bare `>`. The
       header carries no claim of its own, so it is reported on the evidence
       of what follows it. */
    const emptyWarning =
      WARNING_OPENS.test(line) && BLANK_QUOTE.test(lines[at + 1] ?? "");
    /* Which rule fired, and WHERE. Both are for the reader: the list is what
       somebody works from during a cut, and "README.md:351" plus the first 96
       characters of a badge row does not say why that row is in it. None of
       these are global regexes, so `.exec` is stateless here. */
    const why =
      (isBanner && { rule: "banner", at: BANNER.exec(line)?.index ?? 0 }) ||
      (emptyWarning && { rule: "warning with no warning", at: 0 }) ||
      (live.has(at) &&
        PRERELEASE_CLAIM.exec(line) && {
          rule: "pre-release claim",
          at: PRERELEASE_CLAIM.exec(line).index,
        }) ||
      (CLAIM.exec(line) && { rule: "@alpha", at: CLAIM.exec(line).index }) ||
      (META.exec(line) && { rule: "meta", at: META.exec(line).index }) ||
      (POINTS_AT_THE_BANNER.exec(line) && {
        rule: "points at the banner",
        at: POINTS_AT_THE_BANNER.exec(line).index,
      });
    if (why) {
      /**
       * Centre on the EVIDENCE, not on where the rule happened to start.
       *
       * `META` matches from `content="`, which on the site's two description
       * tags is the start of a long sentence about something else entirely —
       * so a window centred there showed everything except the word that put
       * the line in the list. The word itself is the thing a reader is looking
       * for, so it wins when the line has one.
       *
       * `POINTS_AT_THE_BANNER` is the case that has none: "see the warning at
       * the top" is a claim about the banner without naming alpha, and there
       * the rule's own position is the best evidence there is.
       */
      const word = /\balpha\b/iu.exec(line);
      const indent = line.length - line.trimStart().length;
      hits.push({
        line: at + 1,
        text: line.trim(),
        rule: why.rule,
        /* Against the trimmed text, which is what gets printed. */
        at: Math.max(0, (word?.index ?? why.at) - indent),
      });
    }
  });
  return hits;
};

/**
 * Hand edits this gate cannot see — B284, on CW's ask of 2026-09-18.
 *
 * Every rule in this file walks THIS repository. The pages a customer reads
 * live in `byollm-cloud-web`, and they carry alpha sentences of exactly the
 * kind these rules refuse. **A gate that cannot reach them must not imply it
 * has** — so it names them instead, and says plainly that it has not checked.
 *
 * Widening the gate across repositories was considered and declined: it is the
 * divergence shape `byollm_023` names, and a checker that reads a sibling
 * working tree reports on whatever happens to be checked out there. A written
 * list is worse at staying true and better at being honest about it, which is
 * the right trade for five lines somebody reads once per release.
 *
 * Line numbers were read on 2026-09-18 and will drift. They are here so the
 * reader lands near the sentence, not so a script can trust them.
 */
const CROSS_REPO = Object.freeze([
  {
    row: "B284",
    where: "byollm-cloud-web  apps/www/src/app/terms/page.tsx",
    lines: [52, 107, 177],
    what: 'the Terms say "It is in alpha", "During alpha…", "It is alpha software"',
    note:
      "NOT a delete — the middle one is B262's truth about manual provisioning " +
      "and the last is a liability disclaimer. It is a rewrite of what " +
      '"alpha" stands in for, and the Terms are versioned approved copy: ' +
      "CW ruled the version moves to 1.1 and `EFFECTIVE` " +
      '(apps/www/src/app/legal/ui.tsx, "September 16, 2026") moves with it.',
  },
  {
    row: "B279",
    where: "byollm  README.md + five package READMEs",
    lines: [],
    what: "the warning claims the packages have never run outside their own test suite",
    note:
      "Already listed above by the pre-release-claim rule, and repeated here " +
      "because the TRUE sentence is not the one the rule implies: it is false " +
      "today, not merely alpha-flavoured. @byollm/conformance is the one " +
      "package where it holds and is deliberately left alone.",
  },
]);

/** The cross-repo list, printed on every path — refusal and pass alike. */
const crossRepoNotice = () =>
  `\nHAND EDITS THIS GATE CANNOT SEE — it reads this repository only:\n\n` +
  CROSS_REPO.map(
    (item) =>
      `  ${item.row}  ${item.where}` +
      (item.lines.length > 0 ? `:${item.lines.map(String).join(",")}` : "") +
      `\n      ${item.what}\n      ${item.note}\n`,
  ).join("\n") +
  `\n  These are not findings. Nothing here checked them, and nothing in the\n` +
  `  cut will: the flip refuses on what this file can read, and these pages\n` +
  `  are in another repository. They survive a green run unless somebody\n` +
  `  edits them, which is why they are printed rather than assumed.\n`;

const main = () => {
  const root = resolve(process.env["ALPHA_CLAIMS_ROOT"] ?? join(HERE, ".."));
  /* The same manifest `bump-version.mjs` reads `current` from. The root
     package is private and carries no version, so asking it would be asking
     the one file that cannot answer. */
  const manifest = join(root, "packages", "protocol", "package.json");
  if (!existsSync(manifest)) {
    console.error(`alpha-claims: no ${repoPath(root, manifest)} under ${root}`);
    return 2;
  }
  const version = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (typeof version !== "string" || version === "") {
    console.error("alpha-claims: the protocol manifest declares no version");
    return 2;
  }

  /* The tree whose line numbers a reader will see — B253a. */
  const numberFrom = process.env["ALPHA_CLAIMS_NUMBER_FROM"];
  const renumber = (path, hits) => {
    if (numberFrom === undefined) return hits;
    const reference = join(resolve(numberFrom), relative(root, path));
    if (!existsSync(reference)) return hits;
    const lines = readFileSync(reference, "utf8").split("\n");
    return hits.map((hit) => {
      const at = lines.findIndex((line) => line.trim() === hit.text);
      /* Not found: the bump changed this very line, or the reference is not
         the tree this came from. Either way the honest answer is the number
         we have and a mark saying it is not the reader's. */
      return at === -1
        ? { ...hit, line: hit.line, post: true }
        : { ...hit, line: at + 1 };
    });
  };

  const files = documents(root);
  /* A walk that matched nothing satisfies "no document claims alpha", which is
     the shape this repository has shipped before. */
  if (files.length === 0) {
    console.error(`alpha-claims: found no documents under ${root}`);
    return 2;
  }

  const found = [
    ...files.flatMap((path) =>
      renumber(path, liveClaims(readFileSync(path, "utf8"))).map((hit) => ({
        ...hit,
        file: repoPath(root, path),
      })),
    ),
    /* The npm page's own headline — B293. Collected separately because the
       rules above read markdown regions and a manifest has none. */
    ...manifestClaims(root).map((hit) => ({
      ...hit,
      file: repoPath(root, hit.file),
    })),
  ];
  const prerelease = version.includes("-");
  /**
   * One row of the hand-edit list, showing WHAT MATCHED rather than the first
   * 96 characters of the line.
   *
   * Three of the six real hits sit past character 96 — the README's
   * `status-alpha` badge is at ~180, and the site's two `<meta>` descriptions
   * bury "Alpha software, under active development." at the end of a sentence
   * about something else. Head-truncating showed a person an npm badge and no
   * reason it was listed, in the list they work from during a ceremony that
   * cannot be undone.
   *
   * So the window is centred on the match and the rule is named. An ellipsis
   * marks each side that was cut, so nobody reads a fragment as the whole
   * line.
   */
  const WINDOW = 96;
  const show = (hit) => {
    const start = Math.max(0, hit.at - Math.floor(WINDOW / 3));
    const end = Math.min(hit.text.length, start + WINDOW);
    const excerpt =
      (start > 0 ? "…" : "") +
      hit.text.slice(start, end) +
      (end < hit.text.length ? "…" : "");
    return `  ${hit.file}:${String(hit.line)}${hit.post === true ? " (post-bump)" : ""}  [${hit.rule}]  ${excerpt}`;
  };

  if (prerelease) {
    if (found.length === 0) {
      console.error(
        `alpha-claims: the version is ${version} and NO document says so.\n` +
          `A prerelease whose docs have quietly stopped warning is the same\n` +
          `defect as a release whose docs still do, pointing the other way.`,
      );
      return 1;
    }
    console.log(
      `alpha-claims: ${version} is a prerelease and ${String(found.length)} live claim(s) say so, across ${String(files.length)} document(s).`,
    );
    return 0;
  }

  if (found.length > 0) {
    console.error(
      `alpha-claims: the version is ${version} — not a prerelease — and ${String(found.length)} document line(s) still say alpha.\n` +
        `${found.map(show).join("\n")}\n\n` +
        `These are the HAND EDITS — B252, B269.\n` +
        `\`bump-version.mjs\` removed the banner LINE and dropped every\n` +
        `\`@alpha\` dist-tag suffix, because those are mechanical. It does not\n` +
        `touch the rest of a \`> [!WARNING]\` block, so a header left standing\n` +
        `over its own body is listed as "warning with no warning" and the\n` +
        `sentences under it as "pre-release claim". Cut the block; do not cut\n` +
        `the blockquote it sits in, which continues into the release history.\n` +
        `The site's banner carries a feature announcement in the same block —\n` +
        `a script choosing which of those sentences survives would be worse\n` +
        `than this list.\n\n` +
        `This list is what these rules can see, and that is not the same as\n` +
        `everything. It claimed completeness for one release while six warning\n` +
        `bodies stood behind it, unnamed — B269.\n\n` +
        `Why they matter: \`@alpha\` is a dist-tag and the flip moves \`latest\`,\n` +
        `not \`alpha\`. Every line above that still points at it sends a reader\n` +
        `to the last prerelease instead of the version just locked, and the\n` +
        `failure looks like their mistake.\n` +
        `B222: the warning comes out in the same cut.\n` +
        crossRepoNotice(),
    );
    return 1;
  }

  /* "no document" was a claim about every document, made by a reader of one
     repository. It is now scoped to what was actually read, and the rest is
     named — the same correction B269 made when this file claimed completeness
     for one release while six warning bodies stood behind it. */
  console.log(
    `alpha-claims: ${version} is not a prerelease and no document IN THIS ` +
      `REPOSITORY claims otherwise.\n` +
      crossRepoNotice(),
  );
  return 0;
};

/**
 * Run as a command, not when imported — and via `realpathSync`, which is not
 * decoration.
 *
 * `import.meta.url` RESOLVES SYMLINKS and `process.argv[1]` does not. On macOS
 * `/var` is a symlink to `/private/var`, so this script invoked from anywhere
 * under `/tmp` compared `/var/...` with `/private/var/...`, decided it was
 * being imported, ran nothing and **exited 0**. A gate that silently checks
 * nothing and reports success is the exact fail-open every refusal in this
 * file is written against.
 *
 * Found by `rehearse-the-cut.mjs`, which copies the tree to a temp directory
 * and runs the gates there — the first thing it did was report this one green
 * while it had read no files at all.
 */
if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main());
