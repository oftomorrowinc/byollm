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
  text.split("\n").forEach((line, at) => {
    const isBanner = BANNER.test(line);
    const isHistory = /^\s*>/.test(line) && !isBanner;
    if (isHistory) return;
    if (
      isBanner ||
      CLAIM.test(line) ||
      META.test(line) ||
      POINTS_AT_THE_BANNER.test(line)
    )
      hits.push({ line: at + 1, text: line.trim() });
  });
  return hits;
};

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

  const found = files.flatMap((path) =>
    renumber(path, liveClaims(readFileSync(path, "utf8"))).map((hit) => ({
      ...hit,
      file: repoPath(root, path),
    })),
  );
  const prerelease = version.includes("-");
  const show = (hit) =>
    `  ${hit.file}:${String(hit.line)}${hit.post === true ? " (post-bump)" : ""}  ${hit.text.slice(0, 96)}`;

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
        `These are the HAND EDITS, and they are all that is left — B252.\n` +
        `\`bump-version.mjs\` already removed the markdown banners and dropped\n` +
        `every \`@alpha\` dist-tag suffix on this bump, because those are\n` +
        `mechanical. What remains is prose that argues rather than instructs,\n` +
        `plus the site's banner, whose block also carries a feature\n` +
        `announcement — a script choosing which of those sentences survives\n` +
        `would be worse than this list.\n\n` +
        `Why they matter: \`@alpha\` is a dist-tag and the flip moves \`latest\`,\n` +
        `not \`alpha\`. Every line above that still points at it sends a reader\n` +
        `to the last prerelease instead of the version just locked, and the\n` +
        `failure looks like their mistake.\n` +
        `B222: the warning comes out in the same cut.`,
    );
    return 1;
  }

  console.log(
    `alpha-claims: ${version} is not a prerelease and no document claims otherwise.`,
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
