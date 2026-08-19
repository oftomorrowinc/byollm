#!/usr/bin/env node
/**
 * Install the pre-push gate — cloud_008 §3.7.
 *
 * A script rather than a committed `.husky` directory, because this repo has
 * no hook manager and adding one to run four lines is a dependency with a
 * lifecycle. `git config core.hooksPath` would be tidier still and is
 * deliberately not used: it is repo-wide state a contributor may already have
 * set for their own hooks, and silently taking it over is the kind of thing
 * that gets a tool uninstalled.
 *
 * Idempotent, and it refuses to clobber a pre-push hook somebody else wrote.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const MARK = "# byollm verify gate";
const HOOK = `#!/bin/sh
${MARK}
exec node "$(git rev-parse --show-toplevel)/scripts/verify-gate.mjs"
`;

const dir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
  encoding: "utf8",
}).trim();
const path = join(dir, "pre-push");

if (existsSync(path)) {
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(MARK)) {
    process.stderr.write(
      `\n  ${path} exists and is not ours — leaving it alone.\n` +
        "  Add this line to it yourself if you want the gate:\n" +
        "    node scripts/verify-gate.mjs || exit 1\n\n",
    );
    process.exit(1);
  }
}

writeFileSync(path, HOOK);
chmodSync(path, 0o755);
process.stdout.write(`installed pre-push gate at ${path}\n`);
