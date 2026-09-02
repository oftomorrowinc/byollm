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

/**
 * How long a just-landed publish is given to become readable.
 *
 * It was six attempts five seconds apart — twenty-five seconds — and
 * `0.1.0-alpha.59` needed longer: npm answered `+ @byollm/protocol@…` and the
 * read-back called it missing forty-three seconds later. Every package was
 * published; the check was impatient.
 *
 * That is the expensive kind of wrong. This step exists to catch a genuine
 * partial publish, which has happened twice and leaves resolvable packages
 * pointing at a sibling that is not there. A check that also cries wolf is a
 * check people learn to re-run without reading, and the next real partial
 * goes out behind a shrug.
 *
 * Backoff rather than a longer flat interval, so the common case still
 * finishes in seconds and the slow case is waited out instead of failed.
 */
/**
 * Overridable so the giving-up path can be *read* — 2026-09-02.
 *
 * At eight attempts this branch takes twelve minutes across six packages,
 * which means its wording was written blind and reviewed never. The one time
 * it fired in anger it said the wrong thing, and nobody had seen it say
 * anything. A failure message that expensive to reproduce is a failure
 * message nobody edits.
 *
 * Not a behaviour switch: CI and a human at a terminal both get the eight.
 */
const PROPAGATION_ATTEMPTS = Number(
  process.env["RELEASE_CHECK_ATTEMPTS"] ?? "8",
);
const backoff = (attempt) => Math.min(2000 * 2 ** attempt, 30_000);

/**
 * The window in words, so the message cannot drift from the constants.
 *
 * Empty at one attempt, where there is no waiting to describe — "over 0s"
 * read as a bug in the check rather than as a rehearsal.
 */
function describeWindow() {
  let total = 0;
  for (let attempt = 0; attempt < PROPAGATION_ATTEMPTS - 1; attempt += 1) {
    total += backoff(attempt);
  }
  return total === 0 ? "" : ` over ${String(Math.round(total / 1000))}s`;
}

for (const name of names) {
  /**
   * Both reads retry, together.
   *
   * `versions` retried and `dist-tag ls` did not, which is the same bug with
   * a different symptom: when the version landed on the last attempt and the
   * tag had not caught up, this reported "published, but `alpha` points at
   * …" — a second false failure for the one real cause. They are two reads of
   * one eventually-consistent registry and neither is meaningful before the
   * other.
   */
  let versions = [];
  let tags = {};
  for (let attempt = 0; attempt < PROPAGATION_ATTEMPTS; attempt += 1) {
    const raw = npm(["view", name, "versions", "--json"]);
    versions = raw ? JSON.parse(raw) : [];
    tags = Object.fromEntries(
      npm(["dist-tag", "ls", name])
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(": ").map((s) => s.trim())),
    );
    if (versions.includes(version) && tags["alpha"] === version) break;
    if (attempt < PROPAGATION_ATTEMPTS - 1) await sleep(backoff(attempt));
  }

  const published = versions.includes(version);
  const alphaOk = tags["alpha"] === version;

  /**
   * A read that never resolved is a finding about the window, not the release.
   *
   * These are two different sentences and only one of them was ever printed.
   * "`0.1.0-alpha.66` is not on the registry" is a claim about npm's contents,
   * asserted from a read that timed out — and on the .66 release it was
   * false: every package had published, the registry served stale for over
   * the two-minute window, and the same package answered by hand a minute
   * later. The re-run then refused with "every package is already at
   * 0.1.0-alpha.66", which is the check contradicting itself.
   *
   * The cost is the same one the backoff comment already names: a step that
   * cries wolf is a step people re-run without reading, and the next real
   * partial goes out behind a shrug. It had just started doing that.
   *
   * So exhausting the window says so, and says what to do about it — which is
   * to look, not to republish.
   */
  if (!published) {
    problems.push(
      `${name} — ${version} was still unreadable after ` +
        `${String(PROPAGATION_ATTEMPTS)} ` +
        `${PROPAGATION_ATTEMPTS === 1 ? "attempt" : "attempts"}` +
        `${describeWindow()}. That is this check giving up, not npm ` +
        `saying the version is absent.`,
    );
  } else if (!alphaOk) {
    problems.push(
      `${name} — published, but \`alpha\` points at ${tags["alpha"] ?? "nothing"}`,
    );
  }
  if (published && alphaOk && tags["latest"] !== version) {
    behind.push(`${name} (latest: ${tags["latest"] ?? "none"})`);
  }

  const mark = !published ? "UNREAD  " : !alphaOk ? "BAD TAG " : "ok      ";
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
    `\nEither a partial release, or a registry that has not caught up. Those` +
      `\nneed opposite responses and this check cannot tell them apart, so it` +
      `\nreports what it saw rather than deciding.` +
      `\n\n  Look first:  npm view <pkg>@${version} version` +
      `\n\nIf that answers, nothing is wrong — the publish landed and the read` +
      `\npath was stale. If it does not, it is a partial release: some packages` +
      `\nat ${version}, others behind, and every one of them resolvable, which` +
      `\nis the dangerous state.` +
      `\n\nThen re-run the Release workflow for this tag — cloud_008 §37.` +
      `\nPublishing is idempotent per package, so a re-run publishes only what` +
      `\nis missing and converges; if everything is already there it refuses` +
      `\nwith "every package is already at ${version}", which is itself the` +
      `\nanswer. Burning the version was right only when the pre-check refused` +
      `\nany tag a package already had, which turned a stranded publish into a` +
      `\nlost version.`,
  );
  process.exit(1);
}

console.log(`\n${version} is live on every package, tagged \`alpha\`.\n`);
