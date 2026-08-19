#!/usr/bin/env node
/**
 * Stamp the SHA that just passed verify — cloud_008 §3.7.
 *
 * Runs as the last step of `pnpm run verify`, so the file only ever names a
 * commit the whole suite actually passed on. Untracked: it is a fact about
 * this working copy, not about the repository, and committing it would let one
 * machine's green vouch for another's.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync(
  ".verified",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() +
    "\n",
);
