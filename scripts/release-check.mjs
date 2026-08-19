#!/usr/bin/env node
/**
 * Ask the registry whether a release actually happened.
 *
 *   node scripts/release-check.mjs            # the version in the repo
 *   node scripts/release-check.mjs 0.1.0-alpha.11
 *
 * ## Why this exists, and why it does not watch CI
 *
 * The natural way to answer "did the release go out" is to watch the Release
 * workflow. That is what I did for `alpha.11`, and it reported success while
 * npm still served `alpha.10` — the poll had matched the *previous* run,
 * because it started before the new one existed. "A Release run succeeded" is
 * not "my Release run succeeded", and the two are indistinguishable from the
 * outside of a `gh run list`.
 *
 * That is this repository's most-repeated bug wearing yet another hat: a check
 * reporting success for a reason unrelated to the property it claims
 * (`packages/conformance/MUTATIONS.md`).
 *
 * **So this asks about the artifact, not the process.** There is no run id to
 * match, no workflow to name, and nothing that can be right about the wrong
 * release. It queries npm for each package and asserts two things:
 *
 *   1. the version exists, and
 *   2. the `alpha` dist-tag points at it.
 *
 * A partial publish is the failure it is really for. `alpha.6` published four
 * packages and then failed on the fifth — the job did go red, and by then four
 * were live, which is a state no amount of watching the run would have
 * described. This names exactly which package is missing.
 *
 * ## `latest` is reported, never asserted
 *
 * Moving `latest` needs a human with 2FA and is deliberately not automated
 * (see the release workflow's note). So a `latest` behind `alpha` is printed
 * as a reminder rather than a failure — that is a decision somebody has not
 * made yet, not a broken release.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = "packages";

/**
 * Which packages ship — derived, never listed.
 *
 * The same rule the release workflow applies, for the same reason it applies
 * it: `@byollm/relay` was once absent from four hardcoded lists at once, and a
 * tagged release silently published four packages instead of five. A second
 * list here would be a fifth copy, and it would be the copy that tells you the
 * release is fine.
 */
function shippingPackages() {
  const found = [];
  for (const dir of readdirSync(PACKAGES)) {
    const manifest = join(PACKAGES, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    found.push(pkg.name);
  }
  return found.sort();
}

const version =
  process.argv[2] ??
  JSON.parse(readFileSync(join(PACKAGES, "protocol", "package.json"), "utf8"))
    .version;

const npm = (args) => {
  try {
    return execFileSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
};

const names = shippingPackages();
console.log(`\nchecking ${version} across ${String(names.length)} packages\n`);

const problems = [];
const behind = [];

for (const name of names) {
  // Retried, because a publish that has just landed is not instantly visible
  // from every registry edge. Bounded: this is propagation, not a wait for
  // something that has not happened.
  let versions = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const raw = npm(["view", name, "versions", "--json"]);
    versions = raw ? JSON.parse(raw) : [];
    if (versions.includes(version)) break;
    if (attempt < 5) await sleep(5000);
  }

  const tags = Object.fromEntries(
    npm(["dist-tag", "ls", name])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(": ").map((s) => s.trim())),
  );

  const published = versions.includes(version);
  const alphaOk = tags["alpha"] === version;

  if (!published) problems.push(`${name} — ${version} is not on the registry`);
  else if (!alphaOk) {
    problems.push(
      `${name} — published, but \`alpha\` points at ${tags["alpha"] ?? "nothing"}`,
    );
  }
  if (published && alphaOk && tags["latest"] !== version) {
    behind.push(`${name} (latest: ${tags["latest"] ?? "none"})`);
  }

  const mark = !published ? "MISSING " : !alphaOk ? "BAD TAG " : "ok      ";
  console.log(
    `  ${mark} ${name.padEnd(22)} alpha=${tags["alpha"] ?? "-"}  latest=${tags["latest"] ?? "-"}`,
  );
}

if (behind.length > 0) {
  console.log(
    `\n\`latest\` still behind on ${String(behind.length)}: ${behind.join(", ")}` +
      `\n  Not a failure — moving it needs a human with 2FA, on purpose.` +
      `\n  npm dist-tag add <pkg>@${version} latest`,
  );
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\nA partial release is the dangerous state: some packages at ${version},` +
      `\nothers behind, and every one of them resolvable.` +
      `\n\nRe-run the Release workflow for this tag — cloud_008 §37. Publishing` +
      `\nis idempotent per package now, so a re-run publishes only what is` +
      `\nmissing and converges. Burning the version was the answer when the` +
      `\npre-check refused any tag whose version any package already had, which` +
      `\nturned a stranded publish into a lost version.`,
  );
  process.exit(1);
}

console.log(`\n${version} is live on every package, tagged \`alpha\`.\n`);
