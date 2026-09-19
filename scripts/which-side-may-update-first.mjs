#!/usr/bin/env node
/**
 * Which side of a release may update before the hub is rolled — B323.
 *
 *   node scripts/which-side-may-update-first.mjs v0.1.0-alpha.102
 *
 * ## The question, and why it was answered by hand
 *
 * `ready-for-latest.mjs` refuses to promote `latest` until the running hub
 * accepts everything the new version knows. On alpha.103 it named three keys —
 * `Manifest[*].routing`, `Purpose.routing`, and `DeliveredResult.provenance.*`
 * — and refused, correctly.
 *
 * That verdict is about **promotion**. It does not answer the question an
 * operator actually has in the window between publishing and rolling: *may I
 * update the daemons now, or will they start failing against the old hub?*
 *
 * I answered it for alpha.103 by diffing six schemas by hand, after telling
 * Todd to run `npm install --global byollm@alpha` on each Mac. Getting that
 * right by hand once is not a system.
 *
 * ## What it compares
 *
 * Under `.strict()` there is no additive change — B287's whole lesson — so the
 * question is exactly "did any key move on a shape the daemon SENDS to the
 * hub". Those shapes are the request bodies, and they are named here rather
 * than discovered, because the set is the daemon's side of the protocol and a
 * discovered set would silently shrink if an export were renamed.
 *
 * **That is the opposite choice from `wire-shapes.ts`, deliberately.** There,
 * breadth is the point: the outage was a key on a shape nobody had listed. Here
 * narrowness is the point: the answer is about one direction, and including a
 * shape that does not cross it produces exactly the over-claim B322 fixed. A
 * case asserts the list is non-empty and that each name is a real export, so a
 * rename fails loudly rather than shrinking the question.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What a daemon sends to the hub. Narrow on purpose — see the header. */
const DAEMON_SENDS = [
  "HeartbeatRequest",
  "ClaimRequest",
  "ResultRequest",
  "PairStartRequest",
  "PairPollRequest",
  "ReleaseRequest",
  "FetchRequest",
];

/**
 * Where to look — every source file in the package, not a named one.
 *
 * **The first version of this named `job.ts`, and every request schema lives
 * in `wire.ts`.** I had already "verified" the same question by hand with the
 * same wrong file: a `sed` range that matched nothing on both sides, and a
 * `diff` of two empty strings reporting them identical. I told Todd his
 * daemons were safe on the strength of it.
 *
 * The UNPROVEN branch below is what caught it — the check refusing to answer
 * about shapes it could not read, five minutes after I answered the same
 * question from the same absence. That branch is the whole reason this is a
 * script rather than a habit.
 */
const SOURCES = ["packages/protocol/src"];

/** One schema's text, as of a git ref — `undefined` when it is not there. */
function filesAt(ref) {
  const dir = SOURCES[0];
  if (ref === null) {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".ts") && !n.includes(".test."))
      .map((n) => readFileSync(join(dir, n), "utf8"));
  }
  const names = execFileSync(
    "git",
    ["ls-tree", "--name-only", ref, `${dir}/`],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((n) => n.endsWith(".ts") && !n.includes(".test."));
  return names.map((n) =>
    execFileSync("git", ["show", `${ref}:${n}`], { encoding: "utf8" }),
  );
}

function shapeAt(ref, name) {
  let files;
  try {
    files = filesAt(ref);
  } catch {
    return undefined;
  }
  for (const file of files) {
    const at = file.indexOf(`export const ${name} = z`);
    if (at === -1) continue;
    const end = file.indexOf(".strict()", at);
    if (end === -1) continue;
    return file.slice(at, end);
  }
  return undefined;
}

const previous = process.argv[2];
if (previous === undefined) {
  process.stderr.write(
    "usage: which-side-may-update-first.mjs <previous-version-ref>\n\n" +
      "  e.g. v0.1.0-alpha.102 — the release the fleet is on today.\n",
  );
  process.exit(2);
}

const moved = [];
const unreadable = [];
for (const name of DAEMON_SENDS) {
  const before = shapeAt(previous, name);
  const now = shapeAt(null, name);
  if (before === undefined || now === undefined) {
    unreadable.push(name);
    continue;
  }
  if (before !== now) moved.push(name);
}

if (unreadable.length > 0) {
  /* The third state. A shape that cannot be read on one side is not a shape
     that did not change, and answering "safe" here would be the false
     all-clear this whole class of check exists to avoid. */
  process.stderr.write(
    `\nUNPROVEN: could not read ${unreadable.join(", ")} at ${previous} or in ` +
      `the working tree.\n\n  That is this check failing to establish the ` +
      `comparison, not an answer\n  about the wire. Check the ref exists and ` +
      `names a tree with ${SOURCES[0]}.\n`,
  );
  process.exit(1);
}

if (moved.length === 0) {
  process.stdout.write(
    `\nNo daemon-to-hub request shape changed since ${previous}.\n\n` +
      "  Daemons may update BEFORE the hub is rolled: they send nothing the\n" +
      "  running hub can reject. A site that adopts a new manifest field must\n" +
      "  still wait for the roll, and `latest` still moves after it.\n",
  );
  process.exit(0);
}

process.stderr.write(
  `\nROLL THE HUB FIRST — ${String(moved.length)} daemon-to-hub shape(s) ` +
    `changed since ${previous}:\n` +
    moved.map((n) => `  ${n}`).join("\n") +
    "\n\n  Every wire object is `.strict()`, so a daemon on the new version\n" +
    "  sending one of these to a hub that predates it fails the WHOLE body.\n" +
    "  Do not tell anyone to update a daemon until the hub is rolled.\n",
);
process.exit(1);
