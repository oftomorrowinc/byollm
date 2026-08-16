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

let touched = 0;
for (const path of targets) {
  const before = readFileSync(path, "utf8");
  // Literal, not a regex over "any version": `docs/releasing.md` narrates past
  // releases by number and must not be rewritten, which is why history files
  // are not in `targets` at all.
  const after = before.split(current).join(next);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`  ${path}`);
    touched += 1;
  }
}

console.log(`\n${current} → ${next} in ${touched} files`);
console.log("Now: pnpm run verify, commit, then tag.");
