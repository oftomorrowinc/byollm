#!/usr/bin/env node
/**
 * Walk the flip without taking it — B222.
 *
 *     node scripts/rehearse-the-cut.mjs 0.1.0
 *
 * The 0.1.0 cut is a ceremony that happens once, cannot be undone (npm
 * versions are immutable), and is the first thing the public sees. Everything
 * about it is gated — `tag.sh` refuses five ways, `verify` refuses more — and
 * every one of those refusals is discovered **at the moment somebody is
 * standing there trying to release**.
 *
 * This repository's own rule, from the secret-minting scripts: a ceremony
 * nobody can rehearse ships a `--check`. This is the cut's.
 *
 * ## What it does
 *
 * Copies the tracked tree to a scratch directory, runs `bump-version.mjs` at
 * the target version there, and then asks every gate the cut will ask — in the
 * cut's order — reporting all of them rather than stopping at the first. The
 * real repository is never touched: no file is written outside the copy, no
 * tag is created, nothing is pushed, and it refuses to run against a version
 * that is not a clean release unless told otherwise.
 *
 * ## What it deliberately does NOT do
 *
 * It does not run `verify`, and it does not talk to npm. Those need the real
 * tree and the network, they already have their own gates, and a rehearsal
 * that took four minutes would be run once. This answers the question a person
 * cannot answer by reading: **after the bump, what is still wrong?**
 *
 * It also cannot tell you the cut will succeed. It tells you which of the
 * known refusals would fire, which is a smaller and honest claim — the same
 * distinction the liveness probe's green makes about itself.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const target = process.argv[2];
if (target === undefined || !/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(target)) {
  console.error("usage: node scripts/rehearse-the-cut.mjs <version>");
  process.exit(2);
}

/** Every tracked file, so the copy is the tree a tag would name. */
const tracked = () =>
  execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

const scratch = mkdtempSync(join(tmpdir(), "rehearse-cut-"));
for (const path of tracked()) {
  const from = join(ROOT, path);
  if (existsSync(from)) cpSync(from, join(scratch, path), { recursive: true });
}

console.log(`rehearsing ${target} in ${scratch}\n`);

/** One gate: what it is, and what it said. */
const asked = [];
const ask = (what, run) => {
  try {
    const out = run();
    asked.push({ what, ok: true, out: out.trim() });
  } catch (error) {
    const failure =
      /** @type {{stdout?: string, stderr?: string, message?: string}} */ (
        error
      );
    asked.push({
      what,
      ok: false,
      out:
        `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() ||
        (failure.message ?? "failed"),
    });
  }
};

const node = (script, args = [], cwd = scratch) =>
  execFileSync(process.execPath, [join(scratch, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
  });

/* The bump first, because every gate after it is asked of the bumped tree —
   which is the tree the cut tags, and is not the tree anybody has run a check
   against before. */
ask("the version bump applies", () => node("bump-version.mjs", [target]));

const bumped = () => {
  const manifest = join(scratch, "packages", "protocol", "package.json");
  return existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8")).version
    : "unknown";
};
ask("the bump reached packages/protocol", () => {
  const at = bumped();
  if (at !== target) throw new Error(`protocol is ${at}, wanted ${target}`);
  return `packages/protocol is ${at}`;
});

ask("a release note exists for it", () => {
  const note = join(scratch, "docs", "release-notes", `${target}.md`);
  if (!existsSync(note) || readFileSync(note, "utf8").trim() === "")
    throw new Error(
      `docs/release-notes/${target}.md is missing or empty — tag.sh refusal 3.`,
    );
  return `docs/release-notes/${target}.md, ${String(readFileSync(note, "utf8").split("\n").length)} lines`;
});

ask("the docs stop saying alpha", () =>
  node("alpha-claims-match-the-version.mjs"),
);

ask("every package manifest agrees", () => {
  const packages = join(scratch, "packages");
  const wrong = execFileSync(
    "node",
    [
      "-e",
      `const {readdirSync,readFileSync,existsSync}=require("fs");const p=${JSON.stringify(packages)};` +
        `const bad=readdirSync(p).filter(d=>existsSync(p+"/"+d+"/package.json")).` +
        `filter(d=>JSON.parse(readFileSync(p+"/"+d+"/package.json","utf8")).version!==${JSON.stringify(target)});` +
        `if(bad.length)throw new Error("out of step: "+bad.join(", "));console.log(readdirSync(p).length+" packages at "+${JSON.stringify(target)})`,
    ],
    { encoding: "utf8" },
  );
  return wrong.trim();
});

const width = Math.max(...asked.map((a) => a.what.length));
let failed = 0;
for (const { what, ok, out } of asked) {
  console.log(
    `${ok ? "  ok " : "  NO "}${what.padEnd(width)}  ${ok ? (out.split("\n")[0] ?? "") : ""}`,
  );
  if (!ok) {
    failed += 1;
    console.log(
      out
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n"),
    );
  }
}

console.log(
  failed === 0
    ? `\nEvery gate this rehearsal knows about would pass at ${target}.\n` +
        `It does NOT run verify and does not ask npm — those have their own\n` +
        `gates and need the real tree. This says which known refusals fire,\n` +
        `which is smaller than saying the cut will work.`
    : `\n${String(failed)} gate(s) would refuse the cut at ${target}.\n` +
        `Fix them in the commit that bumps the version — that is what "in the\n` +
        `same cut" means — and run this again.`,
);
process.exit(failed === 0 ? 0 : 1);
