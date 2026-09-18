#!/usr/bin/env node
/**
 * Run a mutation, and prove the run happened — the fourth-time rule.
 *
 * Four mutation results in one week were wrong about their own execution, and
 * every one of them looked like a passing check:
 *
 *   - the mutation was applied to a file, and the tests run were in another;
 *   - shell escaping ate a backslash, so the edit never landed;
 *   - `grep -c` returned 0 matches, exit code 1, and `&&` skipped the tests;
 *   - a piped `tail` replaced the command's exit status with its own.
 *
 * Each time the report was "the mutation did not bite", which is the result you
 * act on by weakening a check that was already correct. That is the
 * silent-success bug pointed at ourselves: a measurement that can quietly
 * not-happen and still return something reassuring.
 *
 * So this asserts three things a bare `vitest` run does not:
 *
 *   1. the edit actually changed the file (byte comparison, not a grep);
 *   2. the tests actually ran (a count, not a verdict — "0 failed" and
 *      "0 ran" are the same exit code);
 *   3. the file is restored afterwards, even if the run throws.
 *
 * Usage:
 *   node scripts/mutate.mjs <file> <find> <replace> -- <vitest args...>
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

/**
 * What git thinks of the tree, as a string to compare — B253b.
 *
 * Not a boolean: the tree is legitimately dirty while somebody is working, and
 * refusing to mutate an unsaved feature would make this unusable. What must
 * not change is the SET of dirty files between before and after.
 */
const treeState = () => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  } catch {
    /* Not a checkout, or git is unavailable. Say so rather than silently
       dropping the guarantee — a check that cannot check must not report the
       same thing as one that did. */
    return null;
  }
};

const before = treeState();

/**
 * The mutation that outlives the process that made it — B253b's residual.
 *
 * The `finally` below restores the file, and CW's tree-set guard compares
 * before against after. Both of those need the process to REACH them. A run
 * killed by a signal reaches neither, and today one did: `pkill -f mutate.mjs`
 * left the target patched with its guard replaced by `if (false)`, in a file
 * that was minutes from being committed. Nothing downstream would have said
 * so — the mutation was syntactically valid, and a mutation's whole purpose is
 * to be a plausible edit.
 *
 * So the restore stops depending on this process surviving:
 *
 *   - **SIGINT and SIGTERM are handled** and restore before exiting. That is
 *     Ctrl-C and an ordinary `pkill`, which is how a slow run actually ends.
 *   - **SIGKILL cannot be caught by anything**, so the original bytes are
 *     written to a breadcrumb BEFORE the file is patched. A later run refuses
 *     while it exists, and `--recover` puts the file back from it.
 *
 * The breadcrumb is the load-bearing half. A handler that covers the signals
 * it can catch, with nothing behind it for the one it cannot, is the shape of
 * guard that reads as complete and is not.
 */
const CRUMB = ".mutation-in-progress.json";

const argv = process.argv.slice(2);

if (existsSync(CRUMB)) {
  const held = JSON.parse(readFileSync(CRUMB, "utf8"));
  if (argv[0] === "--recover") {
    writeFileSync(held.file, held.original);
    rmSync(CRUMB);
    console.log(
      `recovered ${held.file} from a run that was killed at ${held.at}.\n` +
        "Check `git diff` before trusting it: anything you edited in that file\n" +
        "since the kill has just been overwritten with the pre-mutation bytes.",
    );
    process.exit(0);
  }
  console.error(
    `refusing to run: a previous mutation of ${held.file} never restored it.\n\n` +
      `  started ${held.at}, and that run did not reach its own cleanup —\n` +
      "  a signal, a crash, or a kill. THE FILE IS STILL MUTATED.\n\n" +
      "  node scripts/mutate.mjs --recover   puts it back from these bytes\n" +
      `  rm ${CRUMB}       if you have already fixed it by hand\n\n` +
      "  Do not commit until one of those has happened. A mutation is a\n" +
      "  plausible edit by construction, which is why nothing else will\n" +
      "  notice it for you.",
  );
  process.exit(2);
}

if (argv[0] === "--recover") {
  console.log("nothing to recover: no mutation is outstanding.");
  process.exit(0);
}

const split = argv.indexOf("--");
if (split < 3) {
  console.error(
    "usage: node scripts/mutate.mjs <file> <find> <replace> -- <vitest args...>",
  );
  process.exit(2);
}
const [file, find, replace] = argv.slice(0, 3);
const testArgs = argv.slice(split + 1);

const original = readFileSync(file, "utf8");
const occurrences = original.split(find).length - 1;
if (occurrences !== 1) {
  console.error(
    `refusing to mutate: found ${String(occurrences)} occurrences of the ` +
      `target in ${file}, expected exactly 1.\n` +
      `A mutation that matched nothing reports "did not bite" and means ` +
      `nothing; one that matched twice tests something you did not choose.`,
  );
  process.exit(2);
}

const mutated = original.replace(find, replace);
if (mutated === original) {
  console.error(`refusing to mutate: the replacement left ${file} unchanged.`);
  process.exit(2);
}

/* Written BEFORE the patch, so the window in which a file is mutated and
   nothing records it is empty rather than small. */
writeFileSync(
  CRUMB,
  JSON.stringify({ file, original, at: new Date().toISOString() }),
);

const restore = () => {
  writeFileSync(file, original);
  if (existsSync(CRUMB)) rmSync(CRUMB);
};

/* The signals that can be caught. `pkill` sends TERM by default, which is how
   a run that is taking too long actually ends. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    console.error(`\n${signal} — restored ${file} before exiting.`);
    process.exit(130);
  });
}

try {
  writeFileSync(file, mutated);
  console.log(`mutated ${file}: ${find.trim().slice(0, 60)}...`);
  // `spawn` with a fixed argv array — byollm_004 §2 bans the shell-invoking
  // variants, and a script that measures our own discipline is a poor place
  // to make an exception to it.
  await new Promise((resolve) => {
    const child = spawn(
      "npx",
      [
        "vitest",
        "run",
        "--reporter=json",
        "--outputFile=/tmp/mutation.json",
        ...testArgs,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("close", resolve);
    child.on("error", resolve);
  });
} finally {
  restore();
  console.log(`restored ${file}`);
}

/**
 * The tree is as it was, or this result is not a result — B253b, CW's ruling.
 *
 * My own harness left a mutation in a tree this morning: it patched three
 * files and restored two, and the only reason it was caught is that the next
 * run failed. **Had that mutation passed, it would have shipped.** Worse, the
 * run that leaves a mutation behind also reports on a tree nobody chose — so
 * the number it prints is about neither the code nor the mutation.
 *
 * Compared as a set of paths rather than as clean-or-dirty, because working
 * on a dirty tree is the normal case and refusing it would make this
 * unusable — which is how a guard gets removed.
 */
const after = treeState();
if (before !== null && after !== null && before !== after) {
  const changed = after
    .split("\n")
    .filter((line) => line !== "" && !before.includes(line));
  console.error(
    "refusing to report: the working tree changed across this run.\n" +
      changed.map((line) => `  ${line}`).join("\n") +
      "\n\n  A mutation result produced against a tree that still carries a\n" +
      "  mutation is not a result. Restore those files and run it again.",
  );
  process.exit(1);
}
if (before === null || after === null) {
  console.error(
    "warning: could not read `git status`, so this run cannot promise it left\n" +
      "the tree as it found it. The result below is about the mutation only.",
  );
}

/** The count, not the verdict — "nothing failed" and "nothing ran" agree. */
let ran = 0;
let failed = 0;
try {
  const report = JSON.parse(readFileSync("/tmp/mutation.json", "utf8"));
  ran = Number(report.numTotalTests ?? 0);
  failed = Number(report.numFailedTests ?? 0);
} catch {
  console.error(
    "the test run produced no report, so nothing is known about whether it " +
      "ran. This is a failed measurement, not a passing mutation.",
  );
  process.exit(1);
}

if (ran === 0) {
  console.error(
    `0 tests ran. The mutation proved nothing — check the paths passed after ` +
      `--, which is how three of the four measurement failures happened.`,
  );
  process.exit(1);
}

console.log(`${String(ran)} tests ran, ${String(failed)} failed`);
if (failed === 0) {
  console.error(
    `\nMUTATION SURVIVED: ${String(ran)} tests ran and none failed.\n` +
      `Either the check does not cover this, or the mutation was harmless. ` +
      `Both are findings; neither is a pass.`,
  );
  process.exit(1);
}
console.log(
  `\nthe mutation was caught by ${String(failed)} of ${String(ran)} tests.`,
);
