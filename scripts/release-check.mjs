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
 * ## And it asks whether the pins moved — B234
 *
 * Todd's ruling, after the third cut in a row whose cross-repo pin was honored
 * by somebody remembering: any release-check surface asserts the pinned
 * version. Asking npm alone reports a green release while the repositories
 * that pin these packages still name the previous one — a check passing for a
 * reason unrelated to the property it claims, which is the failure this file's
 * own header opens with.
 *
 * It runs here rather than at the tag because this is the first moment the
 * whole question can be answered. A lockfile cannot resolve a version npm has
 * not served, so `tag.sh` asks only about the manifests; by the time anybody
 * runs this, the publish has happened and the lockfiles are allowed to agree.
 * Both halves are asked for here, and a disagreement is this script's exit
 * code — not a line in its output.
 *
 * ## `latest` is reported, never asserted
 *
 * Moving `latest` needs a human with 2FA and is deliberately not automated
 * (see the release workflow's note). So a `latest` behind `alpha` is printed
 * as a reminder rather than a failure — that is a decision somebody has not
 * made yet, not a broken release.
 */
import { execFileSync, spawn } from "node:child_process";
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
 * The dist-tag a version of ours is published under — B339.
 *
 * **The same `case` `release.yml` uses to decide where to publish** (§4, "a
 * prerelease goes to its own dist-tag, never to `latest`"), and the same four
 * lines as `byollm-cloud`'s `pins-agree.mjs`. Written from the rule rather
 * than from a memory of it; `release-check.test.mjs` reads `release.yml`'s own
 * `case` and compares, so a third spelling cannot appear quietly.
 *
 * ## Why this replaced the word `alpha`
 *
 * This file asked `tags["alpha"] === version`, and its success line read
 * "live on every package, tagged `alpha`". True while every release was a
 * prerelease; false at the first stable one. `0.1.0` published to `latest`,
 * `alpha` correctly stayed at `0.1.0-alpha.103`, and this check reported
 * **six BAD TAGs and exited 1 on a release that was entirely correct** —
 * every package at 0.1.0, `latest` pointing at it.
 *
 * It then told the operator to re-run the Release workflow, which cannot fix a
 * dist-tag, and the run died before the step that creates the GitHub Release.
 * The checker was the failure, and it cost the v0.1.0 Release page.
 *
 * **Its success path was unreachable for the release it was gating** — the
 * same law as B337 and B338: a check that cannot pass in the environment it
 * runs in never ran the line.
 */
function channelOf(v) {
  if (v.includes("-alpha.")) return "alpha";
  if (v.includes("-beta.")) return "beta";
  if (v.includes("-")) return "next";
  return "latest";
}

/** The channel this run is about, named once and used everywhere. */
const CHANNEL = channelOf(version);

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
/** Packages npm said nothing about at all — B314. */
const silent = [];
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
    if (versions.includes(version) && tags[CHANNEL] === version) break;
    if (attempt < PROPAGATION_ATTEMPTS - 1) await sleep(backoff(attempt));
  }

  const published = versions.includes(version);
  const channelOk = tags[CHANNEL] === version;

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
  /**
   * Did npm answer about this package AT ALL — B314.
   *
   * `tags` is `{}` and `versions` is `[]` only when the read itself failed.
   * A registry that answers `alpha=0.1.0-alpha.102` has told us something
   * true: it is serving, and it does not have the version we asked for.
   *
   * That evidence was already on screen — every UNREAD line prints the
   * package's dist-tags — and the verdict below threw it away.
   */
  if (Object.keys(tags).length === 0 && versions.length === 0) {
    silent.push(name);
  }
  if (!published) {
    unread.push(
      `${name} — ${version} was still unreadable after ` +
        `${String(PROPAGATION_ATTEMPTS)} ` +
        `${PROPAGATION_ATTEMPTS === 1 ? "attempt" : "attempts"}` +
        `${describeWindow()}. That is this check giving up, not npm ` +
        `saying the version is absent.`,
    );
  } else if (!channelOk) {
    problems.push(
      `${name} — published, but \`${CHANNEL}\` points at ${tags[CHANNEL] ?? "nothing"}`,
    );
  }
  if (published && channelOk) readable.push(name);
  /**
   * `latest` lagging is a note for a PRERELEASE and nothing at all otherwise.
   *
   * On a prerelease the channel is `alpha`/`beta`/`next` and `latest` is
   * meant to still name the release before it — that is `release.yml` §4
   * working, and the line below says so without failing. On a stable release
   * the channel IS `latest`, so the same comparison would be the verdict
   * above restated as a warning.
   */
  if (
    CHANNEL !== "latest" &&
    published &&
    channelOk &&
    tags["latest"] !== version
  ) {
    behind.push(`${name} (latest: ${tags["latest"] ?? "none"})`);
  }

  const mark = !published ? "UNREAD  " : !channelOk ? "BAD TAG " : "ok      ";
  console.log(
    `  ${mark} ${name.padEnd(22)} ${CHANNEL}=${tags[CHANNEL] ?? "-"}` +
      (CHANNEL === "latest" ? "" : `  latest=${tags["latest"] ?? "-"}`),
  );
}

if (behind.length > 0) {
  /**
   * **`latest` is not "behind" a prerelease, and must never be moved to one
   * — B339.**
   *
   * This block only runs for a prerelease now, and it read "`latest` still
   * behind" with the remedy `npm dist-tag add <pkg>@${version} latest`. That
   * was written when every release was an alpha and `latest` genuinely lagged.
   *
   * Since 0.1.0 it is inverted: `latest` names 0.1.0 and the version being
   * checked is 0.1.0-alpha.103, so `latest` is AHEAD — and the printed remedy
   * would drag every consumer of `npm install byollm` back onto a prerelease.
   * A remedy nobody should run, offered by a line that calls the correct state
   * a lag.
   *
   * `release.yml` §4 never sends a prerelease to `latest`. So this is context,
   * not a deficit, and it carries no command.
   */
  console.log(
    `\n\`latest\` names something else on ${String(behind.length)}: ${behind.join(", ")}` +
      `\n  Expected — \`release.yml\` §4 never moves \`latest\` for a prerelease.` +
      `\n  Do NOT point \`latest\` at ${version}; that moves every` +
      `\n  \`npm install byollm\` onto a prerelease.`,
  );
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  /**
   * **What this list is, and what it is not — B339.**
   *
   * Every line above is a package that IS published at this version and whose
   * `${CHANNEL}` tag points somewhere else. That is a dist-tag problem, and
   * the tarballs are already on the registry.
   *
   * This said "This is a partial release... Re-run the Release workflow" and
   * both halves were wrong for that. A partial release is packages that did
   * not publish, and those are reported as UNREAD, not here. Re-running the
   * workflow cannot move a dist-tag: publishing is idempotent, so it refuses
   * with "every package is already at this version" and changes nothing — and
   * on 0.1.0 it sent the operator at a registry that was entirely correct
   * while the checker was the thing that was wrong.
   *
   * A remedy that cannot work is worse than none: it is the loop somebody
   * runs twice before they start doubting the message.
   */
  console.error(
    `\nThese packages are PUBLISHED at ${version}; what disagrees is the` +
      `\n\`${CHANNEL}\` dist-tag. Nothing needs republishing.` +
      `\n\nMove the tag, per package:` +
      `\n  npm dist-tag add <pkg>@${version} ${CHANNEL}` +
      `\n\nIt needs a human with 2FA, on purpose. Re-running the Release` +
      `\nworkflow will not do it — publishing is idempotent, so it refuses` +
      `\nwith "every package is already at ${version}" and moves nothing.`,
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
  /**
   * **The third state this check did not have — B314.**
   *
   * The two below assume a publish was ATTEMPTED: *"nothing published at all
   * is a different animal and would have failed the publish step loudly"*.
   * That is true of a release that ran. It is false of a tag that was never
   * pushed, a workflow that never started, and of somebody running this before
   * the release — and in every one of those npm answers perfectly.
   *
   * Told to look at the registry, whoever reads it goes and finds npm working,
   * which is the most expensive kind of wrong diagnosis: correct-looking,
   * unfalsifiable from where they are standing, and pointing away from the tag.
   *
   * Found by running the giving-up path on purpose before using it in a
   * release, which is what the override above exists for.
   */
  const registryAnswered = silent.length === 0;
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
      : registryAnswered
        ? `\nnpm answered for every package and none of them has ${version}.` +
          `\nThe registry is serving reads — the dist-tags above came from it` +
          `\n— so this is not slow propagation and not a partial release.` +
          `\n**This version was never published.**` +
          `\n\n  Look:  git ls-remote --tags origin | grep ${version}` +
          `\n         gh run list --workflow Release --limit 5` +
          `\n\nIf the tag is not there, the tag was never pushed. If it is` +
          `\nthere and no run exists, the workflow did not start. Neither is` +
          `\nfixed by waiting, and both are fixed before touching npm.`
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

/**
 * The pins, last — because "live on npm" and "pinned by the things that run
 * it" are two different claims and only the first one was ever made here.
 *
 * Last rather than first: a partial publish is the more urgent finding and
 * republishing is what fixes it, whereas a stale pin is a commit in another
 * repository and nothing about the release needs redoing. Reading the pin
 * failure before the publish failure would invite somebody to fix the cheap
 * one and re-run.
 */
const pins = await new Promise((settle) => {
  /* `spawn`, not `spawnSync` — byollm_004 §2 bans the shell-invoking
     spellings and eslint enforces it. */
  const child = spawn(
    process.execPath,
    [join("scripts", "pins-checked.mjs"), version],
    { stdio: "inherit" },
  );
  child.on("error", () => {
    settle(1);
  });
  child.on("close", (code) => {
    /* A signal is not an exit code, and `null` would become 0 — the green
       this step exists to withhold. */
    settle(code ?? 1);
  });
});
if (pins !== 0) {
  console.error(
    `\n${version} is live on every package, and the repositories that pin it` +
      `\ndo not all say so. The release is fine; what the fleet runs and what` +
      `\nthose repositories claim are not the same thing yet, which is exactly` +
      `\nthe state nobody can see from the outside — B234.\n`,
  );
  process.exit(1);
}

console.log(`\n${version} is live on every package, tagged \`${CHANNEL}\`.\n`);
