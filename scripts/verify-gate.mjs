#!/usr/bin/env node
/**
 * Refuse a push whose HEAD has not passed `pnpm run verify` — cloud_008 §3.7.
 *
 * Written because "wait for the gate" was a promise, and it was broken three
 * times in one day: pushed, then watched CI or the local run come back with a
 * lint error or a type error that a follow-up commit had to fix. Each time the
 * gate had already been started and the answer simply arrived after the push.
 *
 * A promise that has to be kept on every commit is not a control. This is the
 * same move the rest of the brief keeps making — turn the lesson into
 * something that fails.
 *
 * ## How it decides
 *
 * `pnpm run verify` writes the SHA it verified to `.verified`. This compares
 * that to `HEAD` and refuses when they differ. It deliberately does **not**
 * run verify itself: a hook that takes four minutes gets bypassed, and a hook
 * that is bypassed is worse than none because it reads as protection in the
 * log. Run verify, then push.
 *
 * `--no-verify` still skips it, which is fine: the point is that skipping
 * becomes a thing you *typed*, and the required status on `main` is what makes
 * it not enough on its own.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

if (!existsSync(".verified")) {
  process.stderr.write(
    "\n  refusing to push: nothing has been verified here yet.\n" +
      "  run `pnpm run verify`, then push.\n\n",
  );
  process.exit(1);
}

const verified = readFileSync(".verified", "utf8").trim();
if (verified !== head) {
  const short = (sha) => sha.slice(0, 8);
  process.stderr.write(
    `\n  refusing to push: verify last passed at ${short(verified)}, ` +
      `HEAD is ${short(head)}.\n` +
      "  run `pnpm run verify`, then push.\n\n",
  );
  process.exit(1);
}
