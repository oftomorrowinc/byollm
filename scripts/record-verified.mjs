#!/usr/bin/env node
/**
 * Stamp the SHA that just passed verify — cloud_008 §3.7.
 *
 * Runs as the last step of `pnpm run verify`, so the file only ever names a
 * commit the whole suite actually passed on. Untracked: it is a fact about
 * this working copy, not about the repository, and committing it would let one
 * machine's green vouch for another's.
 *
 * ## Why green prints its own gaps
 *
 * alpha.44 was cut on four commits whose verify was green and whose CI was
 * red. Both failures were real — an example passing a scope word that no
 * longer existed, and a Postgres enum the rename never reached — and neither
 * was reachable from here: one needs a real `next build`, the other a real
 * database. Verify was not wrong, it was *narrower than it read*, and a bare
 * "green" is what let four commits go by.
 *
 * So it says what it did not run. Same rule the log-window lesson produced:
 * evidence offered for a conclusion has to state its coverage, or absence of
 * failure gets read as proof of correctness.
 *
 * The list checks itself against `ci.yml` on every run. A note about coverage
 * that has drifted from the thing it describes is worse than no note, because
 * it is still believed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * A tree with a mutation still in it does not get a stamp.
 *
 * `mutate.mjs` leaves `.mutation-in-progress.json` from the moment it patches
 * a file until it restores one, so the breadcrumb outliving its run means the
 * run was killed and the file is **still mutated**. That happened on 09-18: a
 * `pkill` left a guard replaced by `if (false)` in a file minutes from being
 * committed, and nothing downstream would have said so — a mutation is a
 * plausible edit by construction.
 *
 * This is the last line of `verify`, which makes it the right place to refuse:
 * the stamp is the artifact that says *this tree passed*, and a tree carrying
 * a deliberate sabotage has not passed anything. The harness refuses its own
 * next run too, but that only helps somebody who runs it again — and the
 * failure mode is precisely that nobody does.
 */
const CRUMB = ".mutation-in-progress.json";
if (existsSync(CRUMB)) {
  const held = JSON.parse(readFileSync(CRUMB, "utf8"));
  console.error(
    `refusing to record a verification: ${held.file} is still mutated.\n\n` +
      `  A mutation run started ${held.at} and never restored it.\n` +
      "  Whatever just passed, passed against a file somebody sabotaged on\n" +
      "  purpose — so the result is not a result.\n\n" +
      "  node scripts/mutate.mjs --recover   puts it back, then re-run verify",
  );
  process.exit(1);
}

writeFileSync(
  ".verified",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() +
    "\n",
);

/** Jobs that exist only in CI: what it proves, and the command that runs it. */
const ELSEWHERE = [
  ["a real Next.js build", "pnpm --filter @byollm/example-next build", ""],
  [
    "the relay over real Postgres",
    "pnpm run freeze-gate",
    " (needs SUPABASE_URL + a service key)",
  ],
  [
    "the Supabase adapter certification",
    "pnpm --filter @byollm/conformance run certify:supabase",
    "",
  ],
];

/**
 * Every command CI actually runs, as whole steps.
 *
 * Whole steps, not substrings: `includes()` finds `certify:supabase` inside
 * `certify:supabase-renamed`, so a renamed job reads as still present and the
 * drift check passes while describing a job that is gone. Found by mutating
 * ci.yml and watching this not fire.
 */
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const steps = new Set(
  ci
    .split("\n")
    .map((line) => /^\s*-?\s*run:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((step) => step !== undefined),
);
const drifted = ELSEWHERE.filter(([, command]) => !steps.has(command));
if (drifted.length > 0) {
  process.stderr.write(
    "\nrecord-verified is describing CI jobs that no longer exist:\n" +
      drifted.map(([what, command]) => `  ${what}\n    ${command}\n`).join("") +
      "Update the list in scripts/record-verified.mjs, or verify keeps claiming\n" +
      "a gap that moved — which is how the note stops being read.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "\nverify is green — and does not cover:\n" +
    ELSEWHERE.map(
      ([what, command, note]) => `  ${what}\n    ${command}${note}\n`,
    ).join("") +
    "CI runs all three. A green here is not a prediction that CI passes.\n",
);
