#!/usr/bin/env node
/**
 * Build `CHANGELOG.md` from `docs/release-notes/`, and refuse a stale one —
 * B340.
 *
 * ## Why this is generated
 *
 * The thing it replaces was a hand-maintained list that nothing ever retired:
 * 322 lines of alpha release notes sat above `# BYOLLM` in the root README,
 * and 109 above each package's own title. `release-note.mjs` prepends by
 * design and nothing removed. npm serves the tarball's README, so
 * `npm view byollm@0.1.0 readme` opened with *"`alpha.15` is a breaking wire
 * change"* — on the release whose whole point is that the wire is locked.
 *
 * An index written by hand restates what the directory already says and goes
 * out of step with it the first time somebody adds a note in a hurry. So this
 * derives the index, and `--check` is the half that makes deriving it worth
 * anything: it exits 1 when the file on disk is not what the directory
 * implies, and prints the command that fixes it.
 *
 *     node scripts/changelog.mjs           # write it
 *     node scripts/changelog.mjs --check   # refuse a stale one
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/release-notes";
const OUT = "CHANGELOG.md";

/**
 * Newest first, and the order is computed rather than lexical.
 *
 * `0.1.0-alpha.9` sorts after `0.1.0-alpha.100` as a string, which would put
 * the history in an order no reader could explain — and the reader is the
 * entire point of a changelog.
 */
export function versions(dir = DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort((a, b) => rank(b) - rank(a));
}

function rank(version) {
  const [core, pre] = version.split("-");
  const [major = 0, minor = 0, patch = 0] = (core ?? "").split(".").map(Number);
  /**
   * A release outranks every prerelease of itself: `0.1.0` is above
   * `0.1.0-alpha.103`, which is what `release.yml` §4 means by a prerelease
   * never moving `latest`.
   *
   * **The ceiling is finite, and `Infinity` was the bug — CW caught it at the
   * 0.1.1 cut.** `Infinity` lifts a release above its own prereleases and
   * lifts EVERY release to the same rank, so `0.1.0` and `0.1.1` tied and the
   * sort left them in `readdir` order. The file promises "newest first" in its
   * own second line and listed 0.1.0 above 0.1.1 — the first time there were
   * two stable releases to get wrong, which is the first time it could be
   * seen.
   *
   * 99999 is above any prerelease number we will reach — the largest so far is
   * `alpha.103` — and below the 100000 a patch step adds, so a release stays
   * under the next patch and over its own prereleases. A prerelease numbered
   * past 99999 would outrank its own release, which is why the case below
   * asserts the gap rather than the constant.
   */
  const pre_n = pre ? Number(pre.replace(/\D+/gu, "")) || 0 : 99_999;
  return ((major * 1000 + minor) * 1000 + patch) * 100000 + pre_n;
}

/** The first bolded sentence of a note, which is how every one of ours opens. */
export function summarise(version, dir = DIR) {
  const text = readFileSync(join(dir, `${version}.md`), "utf8");
  /* Blockquote markers come off FIRST. These notes were recovered from
     READMEs where every line began `> `, so a summary spanning a wrapped line
     picked up a stray `>` mid-sentence — "and > there was no upgrade path". */
  const plain = text.replaceAll(/^#.*$/gmu, "").replaceAll(/^\s*>\s?/gmu, "");
  const bold = /\*\*(.+?)\*\*/su.exec(plain);
  /**
   * Most notes open with a bolded sentence; `alpha.21` opens with a
   * `> [!NOTE]` callout and has none, which produced an empty summary, a
   * trailing space after the em-dash, and a row that told the reader nothing.
   * Prettier caught the space; the empty row is the part that mattered.
   */
  const fallback = plain
    .split("\n")
    .map((l) => l.trim())
    .find(
      (l) =>
        l !== "" &&
        !l.startsWith("#") &&
        !l.startsWith("*") &&
        !l.startsWith("[!") &&
        !l.startsWith("<!--"),
    );
  const line = (bold?.[1] ?? fallback ?? "")
    .replace(/^\[!\w+\]\s*/u, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
}

export function render(dir = DIR) {
  const rows = versions(dir).map(
    (v) => `- [\`${v}\`](${dir}/${v}.md) — ${summarise(v, dir)}`,
  );
  return [
    "# Changelog",
    "",
    "Every release note, newest first. Each links to the full note in",
    `\`${dir}/\`.`,
    "",
    "**This file is generated.** Add a note to the directory, then run",
    "`node scripts/changelog.mjs`; `--check` refuses a stale one in `verify`.",
    "",
    ...rows,
    "",
  ].join("\n");
}

const want = render();
if (process.argv.includes("--check")) {
  /* Missing counts as different — a deleted index must be rebuilt, not
     silently accepted. */
  let have;
  try {
    have = readFileSync(OUT, "utf8");
  } catch {
    have = "";
  }
  if (have !== want) {
    process.stderr.write(
      `${OUT} does not match ${DIR}.\n` +
        `  A note was added, renamed or removed and the index was not rebuilt.\n` +
        `  Run: node scripts/changelog.mjs\n`,
    );
    process.exit(1);
  }
  console.log(`changelog: ${versions().length} notes, index current.`);
} else {
  writeFileSync(OUT, want, "utf8");
  console.log(`changelog: wrote ${OUT} (${versions().length} notes).`);
}
