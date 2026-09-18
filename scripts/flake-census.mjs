#!/usr/bin/env node
/**
 * How often does this suite fail, and where — B241, ruled a flip blocker.
 *
 *   node scripts/flake-census.mjs 20            # 20 runs of `pnpm verify`
 *   node scripts/flake-census.mjs 20 --tests    # 20 runs of `vitest run`
 *
 * ## Why a script rather than a shell loop
 *
 * Because the number has to be re-measured after every attempted fix, and a
 * measurement you have to reconstruct is a measurement nobody repeats. CW's
 * ruling requires **N ≥ 20 at `pnpm verify` level, failures counted per case**
 * — and "counted per case" is the part a `for` loop does not do: the question
 * is not "how often is it red" but "is it one test or the suite", and those
 * have different fixes.
 *
 * The first eight-run count already answered that once: one failure in eight,
 * and it was a FOURTH distinct test after three had been catalogued. That is
 * a suite with a timing sensitivity, not four flaky tests, and it is why no
 * assertion has been edited.
 *
 * ## It writes as it goes
 *
 * Twenty runs of `verify` is an hour. A census that only prints at the end is
 * one you cannot look at while it runs and cannot salvage if it is
 * interrupted, so every run appends a line to the report immediately.
 *
 * ## Confirm a green baseline first, or it measures your own mistake
 *
 * The first census ran twenty times and reported **20/20 red** — because this
 * very file was unformatted, and `format:check` is the first step of `verify`.
 * It measured my own untidy diff, twenty times, and would have reported a
 * 100% flake rate on a suite that was fine.
 *
 * What stopped it is the line below that prints **"RED with no FAIL line —
 * look at this run by hand"**: a red run with no failing case is not a data
 * point, it is a question, and a census that turned it into a percentage
 * would have been the exact defect it exists to measure. Run `verify` once and
 * see it pass before starting a census; a measurement of a broken baseline is
 * a number about the wrong thing.
 *
 * ## It does not judge
 *
 * No threshold, no exit code that means "too flaky". The ruling asks for a
 * number so a person can decide; a script that decided would be answering a
 * question that was deliberately given to somebody else.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const runs = Number(process.argv[2] ?? "20");
const bare = process.argv.includes("--tests");
/**
 * Extra arguments for the runner — the discriminator lives here.
 *
 *   --with=--no-file-parallelism    does the flake need files running at once?
 *   --with=--max-workers=12         does more concurrency make it worse?
 *
 * A census that can only measure the default configuration can tell you THAT
 * something is flaky and never WHY. Two arms differing in one flag is the
 * cheapest experiment that separates a slow test from a contended one — and it
 * is repeatable, which an afternoon of shell history is not.
 */
const extra = process.argv
  .filter((arg) => arg.startsWith("--with="))
  .map((arg) => arg.slice("--with=".length));
/** Named after the arm, so two runs do not overwrite each other's evidence. */
const REPORT =
  extra.length === 0
    ? "flake-census.txt"
    : `flake-census${extra.join("").replaceAll(/[^a-z0-9]+/gi, "-")}.txt`;

if (!Number.isInteger(runs) || runs < 1) {
  console.error("usage: flake-census.mjs <runs> [--tests]");
  process.exit(2);
}

/** The command under census. `verify` is the one the ruling names. */
const command = bare
  ? ["npx", ["vitest", "run", ...extra]]
  : ["pnpm", ["run", "verify", ...extra]];

/**
 * Every failing case in a run's output.
 *
 * Vitest prints ` FAIL  |project| path > describe > it`. Taken verbatim and
 * de-duplicated, because vitest reports a failure twice — once in the live
 * list and once in the summary — and counting both would double every number
 * in the census.
 */
function failures(output) {
  const found = new Set();
  for (const line of output.split("\n")) {
    const match = /^\s*FAIL\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) found.add(match[1].trim());
  }
  return [...found];
}

const run = (index) =>
  new Promise((settle) => {
    const child = spawn(command[0], command[1], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("error", () => {
      settle({ index, code: -1, cases: ["(the runner itself did not start)"] });
    });
    child.on("close", (code) => {
      /* A signal leaves `code` null, and null is not zero. A census that
         recorded a killed run as a pass would be the exact defect it is
         measuring, one level up. */
      settle({ index, code: code ?? -1, cases: failures(output) });
    });
  });

const started = new Date().toISOString();
writeFileSync(
  REPORT,
  `flake census — ${String(runs)} x ${command[0]} ${command[1].join(" ")}\n` +
    `started ${started}\n\n`,
);

const tally = new Map();
let red = 0;

for (let index = 1; index <= runs; index += 1) {
  const result = await run(index);
  if (result.code !== 0) red += 1;
  for (const one of result.cases) tally.set(one, (tally.get(one) ?? 0) + 1);

  const line =
    `run ${String(index).padStart(2)}  exit ${String(result.code).padStart(2)}  ` +
    (result.cases.length === 0
      ? result.code === 0
        ? "green"
        : "RED with no FAIL line — look at this run by hand"
      : result.cases.join(" | ")) +
    "\n";
  appendFileSync(REPORT, line);
  process.stdout.write(line);
}

const summary =
  `\n${String(red)}/${String(runs)} runs red ` +
  `(${((red / runs) * 100).toFixed(0)}%)\n\n` +
  (tally.size === 0
    ? "no case failed.\n"
    : [...tally]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `  ${String(count).padStart(3)}  ${name}`)
        .join("\n") + "\n") +
  `\n${String(tally.size)} distinct case(s) failed across ${String(runs)} runs.\n` +
  "A number here that is spread thin across many cases is a suite with a\n" +
  "timing sensitivity; one case carrying nearly all of it is one bug.\n";

appendFileSync(REPORT, summary);
process.stdout.write(summary);
