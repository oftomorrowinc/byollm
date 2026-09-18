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
 * the target version there, and then asks each of `tag.sh`'s refusals — in the
 * cut's order — reporting all of them rather than stopping at the first. The
 * real repository is never touched: no file is written outside the copy, no
 * tag is created and nothing is pushed.
 *
 * **The first version of this file said it asked every gate the cut asks, and
 * it asked three of six.** That is a false claim in the one file whose whole
 * job is to tell the truth about the cut, so the list is now derived from
 * `tag.sh`'s own numbered refusals and each one says which it is. The two it
 * still cannot answer say so out loud rather than being absent:
 *
 *   - **refusal 4, a clean tree**, is a fact about the moment you cut, not
 *     about a copy — so it is reported from the real repository as advice, and
 *     it is the one thing here that can change between now and the tag.
 *   - **`verify`** is not run: it needs the real tree, it takes minutes, and a
 *     rehearsal that took minutes would be run once. It has its own gate.
 *
 * ## What it deliberately does NOT do
 *
 * It does not run `verify`, and it does not talk to npm. Those need the real
 * tree and the network, they already have their own gates, and a rehearsal
 * that took four minutes would be run once. This answers the question a person
 * cannot answer by reading: **after the bump, what is still wrong?**
 *
 * It also cannot tell you the cut will succeed. It tells you which of
 * `tag.sh`'s refusals would fire, which is a smaller and honest claim — the
 * same distinction the liveness probe's green makes about itself.
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

const node = (script, args = [], cwd = scratch, env = {}) =>
  execFileSync(process.execPath, [join(scratch, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

/* The bump first, because every gate after it is asked of the bumped tree —
   which is the tree the cut tags, and is not the tree anybody has run a check
   against before. */
ask("0. the version bump applies", () => node("bump-version.mjs", [target]));

const bumped = () => {
  const manifest = join(scratch, "packages", "protocol", "package.json");
  return existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8")).version
    : "unknown";
};
ask("0. the bump reached packages/protocol", () => {
  const at = bumped();
  if (at !== target) throw new Error(`protocol is ${at}, wanted ${target}`);
  return `packages/protocol is ${at}`;
});

ask("1. this repository publishes at all", () => {
  const workflow = join(scratch, ".github", "workflows", "release.yml");
  if (!existsSync(workflow))
    throw new Error(
      "no .github/workflows/release.yml — a v* tag here publishes nothing.",
    );
  return ".github/workflows/release.yml";
});

ask("2. every package manifest agrees", () => {
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

ask("3. a release note exists for it", () => {
  const note = join(scratch, "docs", "release-notes", `${target}.md`);
  if (!existsSync(note) || readFileSync(note, "utf8").trim() === "")
    throw new Error(
      `docs/release-notes/${target}.md is missing or empty — tag.sh refusal 3.`,
    );
  return `docs/release-notes/${target}.md, ${String(readFileSync(note, "utf8").split("\n").length)} lines`;
});

/**
 * Refusal 5: the cut carries the pin — B234.
 *
 * **The gate that makes this a THREE-REPOSITORY ceremony, and the one the
 * first version of this rehearsal did not ask.** `.95`, `.96` and `.97` were
 * each cut correctly and each needed a second human step afterwards — bumping
 * the two repositories that pin this one — and on `.97` nobody took it.
 *
 * Asked against the REAL siblings, not the copy, because their pins are a real
 * fact about the world and a scratch copy of them would be a rehearsal of a
 * rehearsal. Nothing is written there.
 *
 * `--manifests-only` because a lockfile cannot name a version npm has not
 * served yet; `--committed` because a pin that is only an unsaved edit is not
 * a pin.
 */
ask("5. the two repositories that pin this one name the version", () =>
  execFileSync(
    process.execPath,
    [
      join(ROOT, "scripts", "pins-checked.mjs"),
      target,
      "--manifests-only",
      "--committed",
    ],
    { cwd: ROOT, encoding: "utf8" },
  ),
);

ask("6. the docs stop saying alpha", () =>
  /* Numbered against the REAL tree — B253a. The gate runs on the bumped copy,
     where eight banner lines are gone, so every number below one was off by
     one against the file Todd actually opens and all three README targets
     landed on a blank line. A list that says "go and edit exactly these" has
     to address the file the reader has open. */
  node("alpha-claims-match-the-version.mjs", [], scratch, {
    ALPHA_CLAIMS_NUMBER_FROM: ROOT,
  }),
);

/* Refusal 4 is about the tree you tag, which is the real one at the moment you
   tag it — a copy cannot answer it and pretending otherwise would be the kind
   of green this whole file exists to avoid. Reported, not asked. */
const dirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

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
  dirty === ""
    ? "\n  (4. the working tree is clean — tag.sh checks this at the moment you cut)"
    : `\n  NO 4. the working tree is dirty, and tag.sh refuses that:\n${dirty
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n")}`,
);

console.log(
  failed === 0
    ? `\nEvery refusal this rehearsal can ask would pass at ${target}.\n` +
        `It does NOT run verify and does not ask npm — those have their own\n` +
        `gates and need the real tree. This says which of tag.sh's refusals\n` +
        `fire, which is smaller than saying the cut will work.`
    : `\n${String(failed)} of tag.sh's refusals would fire at ${target}.\n` +
        `Fix them in the commit that bumps the version — that is what "in the\n` +
        `same cut" means — and run this again.\n\n` +
        `If refusal 5 is among them, the cut is a THREE-REPOSITORY sequence:\n` +
        `bump here, bump the pins in byollm-cloud and byollm-cloud-web, commit\n` +
        `all three, then tag. The lockfiles come after the publish, because a\n` +
        `lockfile cannot name a version npm has not served.`,
);
process.exit(failed === 0 ? 0 : 1);
