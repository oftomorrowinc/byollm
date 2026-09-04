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

/**
 * What the registry says, or what a fixture says it says.
 *
 * `RELEASE_CHECK_FIXTURE` names a JSON file of
 * `{ "<package>": { "versions": [...], "dist-tags": {...} } }` and replaces
 * the npm calls entirely. It exists because the tests for this file used to
 * hit the live registry from CI: six packages, several reads each, on three
 * platforms — Windows took **thirty minutes** and then failed on a slow read
 * that says nothing about whether this logic is right.
 *
 * A test that needs the network to say what a function does is a test that
 * reports the network. The real registry is still exercised, by this script
 * doing its actual job on every release; what the suite proves is the
 * reasoning, and it proves it in milliseconds.
 */
const fixturePath = process.env["RELEASE_CHECK_FIXTURE"];
const fixture = fixturePath
  ? JSON.parse(readFileSync(fixturePath, "utf8"))
  : undefined;

const npm = (args) => {
  if (fixture !== undefined) {
    /* `npm view <name> versions --json` puts the name second;
       `npm dist-tag ls <name>` puts it third. Reading it from one position
       gave every package empty tags and turned a fixture of six healthy
       packages into six BAD TAGs — a shim that lies uniformly is a test
       harness that proves the wrong thing quietly. */
    const command = args[0];
    const name = command === "view" ? args[1] : args[2];
    const entry = fixture[name ?? ""];
    if (entry === undefined) return "";
    if (command === "view") return JSON.stringify(entry.versions ?? []);
    return Object.entries(entry["dist-tags"] ?? {})
      .map(([tag, at]) => `${tag}: ${at}`)
      .join("\n");
  }
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
/**
 * Packages the registry would not show us, kept apart from real problems —
 * ruled 2026-09-04.
 *
 * These are two different findings and they were sharing an exit code. A
 * partial release is a fact about npm's contents and needs somebody to act; a
 * read that timed out is a fact about *this check* and needs somebody to look.
 *
 * It cried wolf on three consecutive cuts — .74, .76 and .77, every time on
 * `@byollm/protocol`, which is also the largest package — while every version
 * was in fact live. **A red that is benign three times running is a red people
 * learn to ignore**, which is precisely the failure this step exists to
 * prevent: the next genuine partial goes out behind a shrug.
 *
 * **The prover is not the proven.** Unproven is a third state, and it gets its
 * own exit code and its own word.
 */
const unread = [];
/** Packages this run did confirm, so the message can name the asymmetry. */
const readable = [];
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
  process.env["RELEASE_CHECK_ATTEMPTS"] ?? "14",
);
const backoff = (attempt) => Math.min(2000 * 2 ** attempt, 30_000);

/*
 * There is no third exit code any more — reopened and re-ruled 2026-09-04.
 *
 * The first fix for the wolf-crying gave "could not read" its own exit and
 * reported it as unproven. That was the wrong trade and the review caught it:
 * **a package that was never published and a package the registry is slow to
 * serve are the same empty read**, so making unread benign made a real
 * partial release report green. Trading a false alarm for a false all-clear
 * is the wrong direction for a check whose whole job is catching the
 * dangerous state.
 *
 * What actually fixed the crying wolf was the window, not the exit code. The
 * three cuts that went red were one package — the largest — taking about two
 * minutes against a window of about two. The window is five now, and the
 * observed case never reaches a verdict at all.
 *
 * So after the window, unread fails. What the message does instead of
 * softening the verdict is say which shape it is looking at, because those
 * need different next steps from the person reading it.
 */

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
    unread.push(
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
  if (published && alphaOk) readable.push(name);
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
    `\nThis is a partial release: some packages at ${version}, others behind,` +
      `\nand every one of them resolvable, which is the dangerous state.` +
      `\n\nRe-run the Release workflow for this tag — cloud_008 §37.` +
      `\nPublishing is idempotent per package, so a re-run publishes only what` +
      `\nis missing and converges; if everything is already there it refuses` +
      `\nwith "every package is already at ${version}", which is itself the` +
      `\nanswer. Burning the version was right only when the pre-check refused` +
      `\nany tag a package already had, which turned a stranded publish into a` +
      `\nlost version.`,
  );
  process.exit(1);
}

if (unread.length > 0) {
  /**
   * Asymmetry is the tell, and it is the diagnosis rather than the verdict.
   *
   * A partial release is *by definition* asymmetric: some packages at the new
   * version, others not, and every one of them resolvable. Nothing published
   * at all is a different animal and would have failed the publish step
   * loudly. So a mix says "partial", and a clean sweep of silence says "the
   * registry is not answering" — same exit code, because in both cases we
   * could not confirm the release, and opposite first moves for whoever looks.
   */
  const asymmetric = readable.length > 0;
  console.error(
    `\n${String(unread.length)} package(s) could not be confirmed:`,
  );
  for (const line of unread) console.error(`  ${line}`);
  console.error(
    asymmetric
      ? `\nSome packages answered and these did not, which is the shape of a` +
          `\npartial release: some at ${version}, others behind, and every one` +
          `\nof them resolvable by anyone who installs. That is the dangerous` +
          `\nstate this check exists for.` +
          `\n\n  Confirmed live:  ${readable.join(", ")}` +
          `\n\n  Look:  npm view <pkg>@${version} version` +
          `\n\nIf they all answer, the registry was merely slow past a five-minute` +
          `\nwindow and nothing is wrong. If they do not, re-run the Release` +
          `\nworkflow for this tag — cloud_008 §37. Publishing is idempotent per` +
          `\npackage, so a re-run publishes only what is missing and converges.`
      : `\nNo package answered, which is not the shape of a partial release —` +
          `\na publish that failed outright fails the step above. It is the` +
          `\nshape of a registry that is not serving reads.` +
          `\n\n  Look:  npm view ${names[0] ?? "<pkg>"}@${version} version` +
          `\n\nIf that answers, the read path here was slow past a five-minute` +
          `\nwindow. If nothing answers, wait for npm and re-run this check` +
          `\nrather than the release — the versions are either there or they` +
          `\nare not, and republishing cannot tell you which.`,
  );
  process.exit(1);
}

console.log(`\n${version} is live on every package, tagged \`alpha\`.\n`);
