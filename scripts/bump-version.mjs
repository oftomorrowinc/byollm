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

/** Replace the one live version declaration in a release target. */
function replaceLiveVersion(path, text) {
  return text
    .split("\n")
    .map((line) => {
      const isManifestVersion =
        path.endsWith("package.json") && /^\s*"version"\s*:/.test(line);
      const isReadmeBanner =
        path.endsWith("README.md") && /^\s*>\s*\*\*Alpha \(`/i.test(line);
      const isSiteBanner =
        path === "site/index.html" && /<b>Alpha \(/i.test(line);
      const isDaemonVersion =
        path.endsWith("packages/daemon/src/index.ts") &&
        /^\s*export const DAEMON_VERSION\s*=/.test(line);

      return isManifestVersion ||
        isReadmeBanner ||
        isSiteBanner ||
        isDaemonVersion
        ? line.split(current).join(next)
        : line;
    })
    .join("\n");
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
  const after = replaceLiveVersion(path, before);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`  ${path}`);
    touched += 1;
  }
}

console.log(`\n${current} → ${next} in ${touched} files`);
console.log("Now: pnpm run verify, commit, then tag.");
