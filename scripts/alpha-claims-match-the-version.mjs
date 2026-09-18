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
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The banner `bump-version.mjs` rewrites, matched the way it matches it. */
const BANNER = /^\s*>\s*\*\*Alpha \(/i;

/**
 * A live claim that this is alpha software, or an instruction pinned to the
 * `alpha` dist-tag.
 *
 * `@alpha` catches every install and `npx` line. `status-alpha` is the README
 * badge. `Alpha software` is the site's own words in its meta description —
 * the one place a claim reaches somebody who never opens the page.
 */
const CLAIM = /@alpha\b|status-alpha|Alpha software/i;

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
    if (isBanner || CLAIM.test(line))
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
    console.error(`alpha-claims: no ${relative(root, manifest)} under ${root}`);
    return 2;
  }
  const version = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (typeof version !== "string" || version === "") {
    console.error("alpha-claims: the protocol manifest declares no version");
    return 2;
  }

  const files = documents(root);
  /* A walk that matched nothing satisfies "no document claims alpha", which is
     the shape this repository has shipped before. */
  if (files.length === 0) {
    console.error(`alpha-claims: found no documents under ${root}`);
    return 2;
  }

  const found = files.flatMap((path) =>
    liveClaims(readFileSync(path, "utf8")).map((hit) => ({
      ...hit,
      file: relative(root, path),
    })),
  );
  const prerelease = version.includes("-");
  const show = (hit) =>
    `  ${hit.file}:${String(hit.line)}  ${hit.text.slice(0, 96)}`;

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
        `The banner is the easy half. The rest are INSTRUCTIONS pinned to the\n` +
        `\`alpha\` dist-tag, and the flip moves \`latest\` and not \`alpha\` — so\n` +
        `each one tells a reader to install the last prerelease instead of the\n` +
        `version just locked, and the failure looks like their mistake.\n` +
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
