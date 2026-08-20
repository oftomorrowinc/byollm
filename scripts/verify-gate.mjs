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
 *
 * ## The order this forces, which is the right one
 *
 * **Commit, then verify, then push.** The first thing this hook did was refuse
 * a push of its own commit, because verify had been run before the commit
 * existed and the stamp named the parent. That is not a rough edge — verify
 * has to run on the exact tree being pushed, and running it beforehand
 * verifies something else that happens to be nearby.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/**
 * A `v*` tag has to be publishable *here* — 2026-08-20.
 *
 * `v0.1.0-alpha.28` was created and pushed in a repository with no release
 * workflow. Nothing ran, nothing published, and nothing said why: the tag was
 * correct, in a repository that does not publish. This is the thing that
 * looks.
 *
 * Two questions, in the order that would have caught that morning:
 *
 *   1. Does this repository publish at all? No `release.yml`, no `v*` tags.
 *   2. If it does, does the tag name the version `packages/` carries?
 *      `release.yml` asks this server-side; asking here turns a failed
 *      workflow run into a message before the push.
 *
 * The twin of this function lives in the other repository's `verify-gate.mjs`
 * and is deliberately identical — one of them refuses every `v*` tag and the
 * other refuses a mismatched one, and which it does is decided by what is on
 * disk rather than by the copy being different.
 */
function refuseUnpublishableTags() {
  // The refs being pushed arrive on stdin as
  // `<local ref> <local sha> <remote ref> <remote sha>` lines. Absent when a
  // person runs this by hand, which must not hang.
  let input = "";
  try {
    if (!process.stdin.isTTY) input = readFileSync(0, "utf8");
  } catch {
    return;
  }

  const tags = input
    .split("\n")
    .map((line) => line.split(" ")[0] ?? "")
    .filter((ref) => ref.startsWith("refs/tags/v"))
    .map((ref) => ref.slice("refs/tags/".length));
  if (tags.length === 0) return;

  if (!existsSync(".github/workflows/release.yml")) {
    process.stderr.write(
      `\n  refusing to push ${tags.join(", ")}: this repository has no\n` +
        "  .github/workflows/release.yml, so a v* tag here publishes nothing.\n" +
        "  You are probably in the wrong repository — the one that publishes\n" +
        "  is the one with packages/ in it.\n\n",
    );
    process.exit(1);
  }

  if (!existsSync("packages/protocol/package.json")) return;
  const version = JSON.parse(
    readFileSync("packages/protocol/package.json", "utf8"),
  ).version;
  for (const tag of tags) {
    if (tag !== `v${version}`) {
      process.stderr.write(
        `\n  refusing to push ${tag}: the packages here are ${version}.\n` +
          "  A tag that disagrees with the version publishes nothing and\n" +
          "  fails the workflow. `./scripts/tag.sh` makes the matching one.\n\n",
      );
      process.exit(1);
    }
  }
}

refuseUnpublishableTags();

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
