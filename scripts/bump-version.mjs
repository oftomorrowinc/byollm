#!/usr/bin/env node
/**
 * Set every version in the repo to one value.
 *
 * This exists because the release has now failed twice for the same reason: a
 * tag pushed against packages that still named the previous version. The
 * workflow's guard caught it both times and published nothing, which is the
 * guard working — but "remember to bump eleven files" is not a process, it is
 * a thing to forget, and it was forgotten twice by the same person.
 *
 * Finds the files rather than listing them, for the reason the release
 * workflow now derives its package list: a hardcoded list is a list somebody
 * adds a file beside. `@byollm/relay` was missed by exactly that.
 *
 *   node scripts/bump-version.mjs 0.1.0-alpha.6
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(next)) {
  console.error("usage: node scripts/bump-version.mjs <version>");
  process.exit(2);
}

const current = JSON.parse(
  readFileSync("packages/protocol/package.json", "utf8"),
).version;
if (current === next) {
  console.error(`already at ${next}`);
  process.exit(2);
}

const targets = [
  ...readdirSync("packages")
    .filter((d) => existsSync(join("packages", d, "package.json")))
    .flatMap((d) => [
      join("packages", d, "package.json"),
      join("packages", d, "README.md"),
    ]),
  "README.md",
  "site/index.html",
  "packages/daemon/src/index.ts",
].filter((p) => existsSync(p));

/**
 * Is this a release rather than a prerelease? `0.1.0`, not `0.1.0-alpha.102`.
 *
 * The one question that changes what a bump MEANS — B252. Up to here every
 * bump was alpha-to-alpha and the only live version state was the number
 * itself. A bump to a clean version also retires every sentence that says this
 * is an alpha, and `tag.sh` refuses the cut until they are gone.
 */
const isRelease = (version) => !version.includes("-");

/**
 * Lines the bump DELETES at a clean version — B252, CW's ruling.
 *
 * The alpha banner, in both shapes: the markdown blockquote eight READMEs
 * carry, and the orange bar across the top of the site. Rewritten to the new
 * number by the rule below at every alpha bump, and at a release there is no
 * new number to rewrite it to — *"Alpha (`0.1.0`) — don't use this yet"* is a
 * sentence contradicting itself, on the most-read files in the repository, in
 * the commit that makes them public.
 *
 * **Markdown only, and the site's banner is deliberately NOT here.** I wrote
 * the HTML rules first and they broke the page: `site/index.html`'s orange bar
 * is one `<div>` containing the alpha warning AND a feature announcement
 * ("Team routing: share a model on your device..."), so a line filter either
 * orphans that text in `<body>` or deletes a paragraph that has nothing to do
 * with being an alpha. Which sentences survive is a judgement, and a script
 * making it silently on the marketing site at the flip is worse than a line on
 * a list. The gate names it as a hand edit.
 */
const RETIRED_AT_RELEASE = [/^\s*>\s*\*\*Alpha \(/i];

/**
 * `@alpha` is a DIST-TAG, and the flip does not move it — B252.
 *
 * `npm install @byollm/protocol@alpha` and `npx --package @byollm/server@alpha
 * keygen` keep resolving to the last prerelease after 0.1.0 publishes, because
 * the workflow moves `latest` and nothing moves `alpha`. A reader following
 * our own quickstart would install an OLDER package than the one just locked
 * and conclude they did it wrong.
 *
 * Dropping the suffix is the whole fix: a bare name resolves to `latest`,
 * which is where the release is and where every later one will be.
 */
const dropAlphaTag = (line) =>
  line.replaceAll(/(@byollm\/[a-z-]+)@alpha\b/gu, "$1");

/** Replace the one live version declaration in a release target. */
function replaceLiveVersion(path, text) {
  return text
    .split("\n")
    .map((line) => {
      const isManifestVersion =
        path.endsWith("package.json") && /^\s*"version"\s*:/.test(line);
      /**
       * **The README banner's shape changed at the flip and this rule did not
       * — found at the 0.1.1 cut.**
       *
       * It matched `> **Alpha (\`` only. The flip's banner is
       * `> **\`0.1.0\` — early.**` in Todd's approved words, so from 0.1.0
       * onward the bumper silently stopped maintaining the most-read line in
       * the repository. The comment below already made this argument for the
       * SITE banner and widened that one; the README's was left behind.
       */
      const isReadmeBanner =
        path.endsWith("README.md") &&
        /^\s*>\s*\*\*(?:Alpha \(`|`\d+\.\d+\.\d)/i.test(line);
      const isSiteBanner =
        path === "site/index.html" &&
        /<b>(?:Alpha \(|\d+\.\d+\.\d)/i.test(line);
      const isDaemonVersion =
        path.endsWith("packages/daemon/src/index.ts") &&
        /^\s*export const DAEMON_VERSION\s*=/.test(line);

      /**
       * The banner line carries TWO versions and only one of them moves.
       *
       * Todd's wording is `**\`0.1.0\` — early.** The protocol is version 2
       * as of 0.1.0; …` — the first names what you are reading, the second is
       * a permanent fact about when protocol 2 arrived. `split/join` renumbers
       * both and turns a true sentence into "version 2 as of 0.1.1", which
       * would be false the moment it was written.
       */
      if (isReadmeBanner) return line.replace(current, next);

      return isManifestVersion || isSiteBanner || isDaemonVersion
        ? line.split(current).join(next)
        : line;
    })
    .join("\n");
}

/**
 * **The banner's shape changed at the 0.1.0 cut, so this pattern had to.** It
 * read `<b>Alpha (` only; the flip's banner is `<b>0.1.0 — early.</b>`, and a
 * rule that no longer matches it would leave the marketing page naming 0.1.0
 * for ever. `check-site.mjs` requires the version to be there, which is what
 * makes the staleness loud rather than silent — but loud at the next cut is
 * still worse than maintained. Only the NUMBER is touched here; which
 * sentences survive a flip stays a hand edit, for the reason below.
 *
 * What a bump to a RELEASE does on top of renumbering — B252.
 *
 * CW's ruling: *"on a non-prerelease target the bumper removes the banner and
 * rewrites the mechanical `@alpha` suffixes; the gate stays as the backstop,
 * not the instrument."* A refusal that fires in the middle of a cut, four days
 * before a flip, is where mistakes live — the gate is correct and making a
 * person satisfy it by hand at that exact moment is not.
 *
 * The bumper is the right owner because it already holds the classification of
 * which lines are live, and `alpha-claims-match-the-version.mjs` took its rule
 * from here so the two cannot drift. **The edit belongs with the
 * classification.**
 *
 * What it deliberately does NOT touch: prose that argues rather than
 * instructs — *"Ask for `@alpha` explicitly"*, the `status-alpha` badge, the
 * site's meta descriptions. Those are judgement, they genuinely change at the
 * cut, and a script rewriting somebody's sentences is worse than a short list.
 * The gate names them, and only them, which is the difference between a
 * fourteen-item refusal and a three-item one.
 */
function retireAlpha(path, text) {
  const lines = text.split("\n");
  const kept = lines
    .filter((line) => !RETIRED_AT_RELEASE.some((shape) => shape.test(line)))
    .map(dropAlphaTag);
  /* The banner is the first line of every README and is followed by a blank.
     Removing one without the other leaves the document opening on an empty
     line, which renders as a gap above the title on npm and on GitHub — the
     kind of thing nobody notices until it is the front page of a launch.
     Only when something was actually removed: a file that legitimately opens
     with a blank line is not this script's business. */
  if (kept.length !== lines.length)
    while (kept.length > 0 && kept[0]?.trim() === "") kept.shift();
  return kept.join("\n");
}

let touched = 0;
for (const path of targets) {
  const before = readFileSync(path, "utf8");
  // Only the declaration/banner in each target is live version state. README
  // bodies are history too: marked release-note bodies span several lines,
  // and package-specific breaking notes may be unmarked. Replacing every
  // occurrence rewrites both kinds whenever their release equals `current`.
  //
  // Keep the path-aware rewrite in a pure helper so the history case stays
  // executable in CI rather than depending on another real release to recur.
  const renumbered = replaceLiveVersion(path, before);
  const after = isRelease(next) ? retireAlpha(path, renumbered) : renumbered;
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`  ${path}`);
    touched += 1;
  }
}

console.log(`\n${current} → ${next} in ${touched} files`);
console.log("Now: pnpm run verify, commit, then tag.");
