#!/usr/bin/env node
/**
 * Add a release note to every package README, verifiably — cloud_008 §36.
 *
 * Written because the ad-hoc version of this fooled me three times. Each
 * release I inserted a note with a one-off script guarded by
 * `if (readme.includes("alpha.N")) skip`, and each time that matched the
 * **version banner** at the top rather than the note — so the note was
 * silently skipped and my own verification counted the banner too.
 *
 * A check that reads the same string two different things can write is not a
 * check. Notes carry a marker nothing else uses:
 *
 *     <!-- release-note 0.1.0-alpha.21 -->
 *
 * `bump-version.mjs` leaves marked lines alone, so a note about alpha.19 still
 * says alpha.19 after the next bump. That is finding 36's substance: not that
 * history was being rewritten — the notes use a short form the bump never
 * matched — but that the banner and the notes shared a namespace, which made
 * every "is this version mentioned?" question ambiguous.
 *
 *   node scripts/release-note.mjs 0.1.0-alpha.21 note.md
 *
 * Prints what it wrote per file, and exits non-zero if any README did not
 * receive it — the verification the one-off scripts kept getting wrong.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [version, notePath] = process.argv.slice(2);
if (!version || !notePath) {
  process.stderr.write("usage: release-note.mjs <version> <note.md>\n");
  process.exit(2);
}

const marker = `<!-- release-note ${version} -->`;
const body = readFileSync(notePath, "utf8").trim();
const block = `${marker}\n${body}\n`;

const readmes = readdirSync("packages")
  .map((d) => join("packages", d, "README.md"))
  .filter((p) => existsSync(p));

/** After the warning block, before the first heading — where a reader looks. */
const ANCHOR = /^# /m;

let wrote = 0;
for (const path of readmes) {
  const before = readFileSync(path, "utf8");
  if (before.includes(marker)) {
    process.stdout.write(`  = ${path} (already has it)\n`);
    wrote += 1;
    continue;
  }
  const at = ANCHOR.exec(before);
  if (!at) {
    process.stdout.write(`  ! ${path} — no heading to place it before\n`);
    continue;
  }
  writeFileSync(
    path,
    before.slice(0, at.index) + block + "\n" + before.slice(at.index),
  );
  process.stdout.write(`  + ${path}\n`);
  wrote += 1;
}

if (wrote !== readmes.length) {
  process.stderr.write(
    `\n  ${String(wrote)}/${String(readmes.length)} READMEs took the note\n`,
  );
  process.exit(1);
}
process.stdout.write(`\n${String(wrote)} README(s) carry ${marker}\n`);
