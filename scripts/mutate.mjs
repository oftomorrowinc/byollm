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
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
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

let result;
try {
  writeFileSync(file, mutated);
  console.log(`mutated ${file}: ${find.trim().slice(0, 60)}...`);
  result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "--reporter=json",
      "--outputFile=/tmp/mutation.json",
      ...testArgs,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} finally {
  writeFileSync(file, original);
  console.log(`restored ${file}`);
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
