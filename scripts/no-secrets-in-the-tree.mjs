#!/usr/bin/env node
/**
 * No credential shapes in the tracked tree — B224's public-repo half.
 *
 *     node scripts/no-secrets-in-the-tree.mjs
 *
 * The pre-public sweep (`c6634db`) read the tree and 858 commits of history
 * and found nothing. **That was an action, not a gate.** It says something
 * true about the repository as it stood and nothing at all about the next
 * commit, and this repository is about to be public and stay public — where a
 * leaked key is not deletable, because history is cloned within minutes.
 *
 * ## What it asks, and the limit it has
 *
 * Tracked files only, at the current tree. A secret has to pass through the
 * tree to reach history, so guarding the tree on every `verify` and every CI
 * run is what stops one arriving. **It does not re-scan history** — that was
 * the sweep's job, it takes minutes, and a gate nobody waits for is a gate
 * somebody removes from the chain.
 *
 * ## Its pair, and why both exist
 *
 * `the-repo-ships-nothing-local.test.mjs` checks tracked file NAMES — a file
 * called `credentials.json` is an accident caught for free. This checks
 * CONTENT. Neither subsumes the other and the split is deliberate, said here
 * because two checks about secrets look like duplication to somebody tidying.
 *
 * That file argues the content half belongs to GitHub's secret scanning once
 * the repository is public. That was **false when written** — both controls
 * were off, asked with an admin token on 2026-09-18 — and Todd enabled them
 * the same day. So this is the **local, pre-push half**: it runs in `verify`
 * and in CI before a push exists, where push protection runs at the push and
 * only for provider patterns. For one day it was the only content-level check
 * there was.
 *
 * ## Why prefixes and not entropy
 *
 * An entropy scanner finds base64 in a fixture, a hash in a lockfile and a
 * minified chunk, and the third false alarm is the one that gets it deleted —
 * this project has written that sentence about four different checks. Every
 * pattern below is anchored to an issuer's own prefix, so a match is a
 * credential shape rather than a suspicious-looking string.
 *
 * The cost is honest and stated rather than hidden: a secret with no
 * recognisable prefix — a bare password, a random hex token — passes here.
 * This catches what is catchable with no false alarms, which is the trade that
 * keeps a gate alive.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["SECRET_SCAN_ROOT"] ?? join(HERE, ".."));

/**
 * Credential shapes, each anchored to the prefix its issuer mints.
 *
 * Written so that **this file does not match itself**: a pattern's own text
 * never satisfies it, because the prefix here is not followed by the run of
 * characters the pattern requires. A scanner that flagged its own source would
 * be switched off on its first run, and there is a case for it.
 */
const SHAPES = [
  { name: "an OpenSSH/PEM private key", re: /BEGIN [A-Z ]*PRIVATE KEY/u },
  { name: "a GitHub personal access token", re: /\bghp_[A-Za-z0-9]{20,}/u },
  {
    name: "a GitHub fine-grained token",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  },
  { name: "an npm publish token", re: /\bnpm_[A-Za-z0-9]{30,}/u },
  { name: "a Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{10,}/u },
  { name: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "a Google API key", re: /\bAIza[A-Za-z0-9_-]{35}\b/u },
  {
    name: "a signed JWT (Supabase service keys are these)",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  },
  { name: "a Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/u },
];

const NUL = String.fromCharCode(0);

const tracked = (root) =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split(NUL)
    .filter((path) => path !== "");

/** Is it text we can read? A binary blob is not where a key is pasted. */
const readable = (path) => {
  try {
    if (statSync(path).size > 2_000_000) return null;
    const body = readFileSync(path, "utf8");
    return body.includes(NUL) ? null : body;
  } catch {
    return null;
  }
};

const main = () => {
  const files = tracked(ROOT);
  /* A reader that found no files would report a perfectly clean repository. */
  if (files.length < 10) {
    console.error(
      `secret scan: only ${String(files.length)} tracked file(s) found — not a checkout, or the layout moved`,
    );
    return 2;
  }

  const found = [];
  for (const path of files) {
    const body = readable(join(ROOT, path));
    if (body === null) continue;
    for (const [index, line] of body.split("\n").entries()) {
      for (const { name, re } of SHAPES) {
        if (re.test(line)) found.push({ path, line: index + 1, name });
      }
    }
  }

  if (found.length > 0) {
    console.error(
      `${String(found.length)} credential shape(s) in tracked files:\n` +
        found
          .map(({ path, line, name }) => `  ${path}:${String(line)}  ${name}`)
          .join("\n") +
        "\n\nIf one of these is real, it is already compromised — rotate it first,\n" +
        "then remove it. A public repository is cloned within minutes, and\n" +
        "rewriting history does not recall what was already fetched.\n\n" +
        "If it is an example, make it obviously fake: truncate it, or use a\n" +
        "placeholder that cannot be mistaken for a live credential.",
    );
    return 1;
  }
  console.log(
    `no credential shapes in ${String(files.length)} tracked files ` +
      `(${String(SHAPES.length)} issuer prefixes).\n` +
      "Prefix-anchored, so a secret with no recognisable prefix passes; and this\n" +
      "reads the tree rather than history, which is what stops a new one arriving.",
  );
  return 0;
};

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main());
