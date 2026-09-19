import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm verify` must leave this repository's working tree as it found it.
 *
 * Written after a night that produced three instances of one class in this
 * project, none of which any suite noticed:
 *
 *  - `byollm-cloud`'s `publish-image.sh` gained a preamble above the point
 *    where it reads whether it is pretending, so **every `pnpm verify` moved
 *    the operator's real roll checkout** and started a second verify inside it,
 *    on its way to building and pushing a fleet image. Three green runs — 903,
 *    914, 916 tests — while it happened (B326, B333);
 *  - and in this repository, a one-line probe run from the wrong directory
 *    renumbered **fifteen tracked files** to `0.1.0`, because
 *    `bump-version.mjs` rewrites every manifest under `process.cwd()`. That is
 *    the whole reason `rehearse-the-cut.mjs` copies the tree before it bumps,
 *    and the whole reason its tests pass `cwd: <fixture>`.
 *
 * A test that forgets that `cwd` does not fail. It renumbers the repository and
 * passes, and the next thing anybody hears is a release carrying a version
 * nobody chose.
 *
 * ## Compared, not demanded
 *
 * It records the tree before and after and refuses a run that CHANGED it —
 * uncommitted work in progress is nobody's business here and must keep
 * working. Ignored files are out of scope by `git status --porcelain`'s own
 * rule, which is what keeps build output and `.verified` from tripping it.
 *
 * ## Why a global hook
 *
 * The property is about the whole run. No single case can observe "nothing was
 * rewritten while the suite ran", and one that checked at its own moment would
 * pass or fail on file ordering.
 *
 * **A deliberate twin of `byollm-cloud`'s `nothing-outside-moves.ts`**, which
 * watches the roll checkout for the same reason. Two repositories, one rule,
 * and no shared package to put it in — the same shape `verify-gate.mjs` already
 * says of its own twin.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every tracked change, as one string. Ignored files are excluded by git. */
export function treeState(root = ROOT) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    /* No git, or a broken repository. Not a change, and not something to fail
       a suite over — an unreadable answer is not a negative one. */
    return "unreadable";
  }
}

/** What changed, as a sentence — or `null` when the answer is "nothing". */
export function changedMessage(before, after) {
  if (before === after) return null;
  const was = new Set(before.split("\n").filter((line) => line !== ""));
  const now = after.split("\n").filter((line) => line !== "");
  const appeared = now.filter((line) => !was.has(line));
  const body =
    appeared.length > 0
      ? appeared.map((line) => `    ${line}`).join("\n")
      : "    (files the suite reverted or removed)";
  return (
    "\n  pnpm verify CHANGED this repository's working tree.\n" +
    "  A test wrote into the real tree instead of a fixture — most likely by\n" +
    "  running a script without `cwd`. `bump-version.mjs` rewrites every\n" +
    "  manifest under the directory it is run in.\n\n" +
    `${body}\n\n` +
    "  Nothing in the suite may do this. See B333.\n"
  );
}

export default function setup() {
  const before = treeState();
  return () => {
    const message = changedMessage(before, treeState());
    if (message === null) return;
    /**
     * Printed AND fatal. `byollm-cloud`'s twin threw from here first, and
     * vitest caught it, printed the whole complaint and **exited 0** — a
     * watcher that reports a real breach inside a green run is the class it
     * was built to stop. `process.exit` because this runs after the reporter
     * has finished; a failing suite is already non-zero, so it cannot turn a
     * red run green.
     */
    process.stderr.write(message);
    process.exit(1);
  };
}
