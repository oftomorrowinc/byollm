#!/usr/bin/env node
/**
 * A package publishing for the FIRST time is announced before the cut.
 *
 *     node scripts/a-first-publish-is-announced.mjs
 *
 * ## The find this exists because of
 *
 * `@byollm/agreements` was added at 2026-09-17 23:44, three hours after
 * `v0.1.0-alpha.102` was tagged at 20:34. It carries a version in lockstep
 * with its six siblings, `publishConfig.access: "public"`, and no `private`
 * flag — and the release workflow's rule is explicit:
 *
 * > Anything under packages/ that is not `private` ships. To keep a package
 * > out of a release, mark it private; there is no list to forget to update.
 *
 * So the next tag carries it into the release, and the next tag is the 0.1.0
 * flip. B039 sits BLOCKED on "the publish decision" for that exact package.
 *
 * ## What actually happens — corrected 09-18 after READING the workflow
 *
 * **The first version of this file said the flip would publish it silently.
 * That is wrong, and `release.yml` is better than I gave it credit for.** It
 * asks the registry about every name in `$PKGS` *before publishing anything*:
 *
 *     if ! npm view "$name" name >/dev/null 2>&1; then
 *       echo "::error::$name has never been published, so trusted publishing
 *             cannot be configured for it …"
 *       exit 1
 *
 * The release **stops at a precondition check**. Nothing is half-published, no
 * name is claimed by accident, and the error carries its own remedy. The
 * repository had already thought about this exact case, and I asserted the
 * opposite in a note that went to the top of Todd's list.
 *
 * ## Which makes this file MORE useful, not less
 *
 * The cost is not an irreversible name claim. It is **a release that fails
 * after the tag exists** — the tag is pushed before the workflow runs, so the
 * failure arrives with `v0.1.0` already on the remote and a red run under it.
 * Getting out means deleting a tag, or cutting the next patch to step past a
 * name nobody meant to publish.
 *
 * Telling somebody before they tag is worth what it always was. The sentence
 * under it just has to be true: a first publish here is a **decision with a
 * one-time manual setup**, not an accident waiting to happen.
 *
 * ## Reported, not refused
 *
 * This exits 1 when a first publish is coming, the way `git diff
 * --exit-code` does: "there is something here for you", not "you are wrong".
 * It is deliberately **not** in `verify` — a package that has not shipped yet
 * is a normal state, not a defect, and a gate that reddened every commit
 * until somebody released would be removed within the day.
 *
 * And it is not a `tag.sh` refusal, though it could be. Adding a refusal
 * changes how the cut is performed, and the shape of Todd's hands is his:
 * this announces, and he rules whether it should also stop.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["FIRST_PUBLISH_ROOT"] ?? join(HERE, ".."));

/**
 * What the registry says, or what a fixture says it says.
 *
 * Same seam and same reason as `release-check.mjs`: a test that needs the
 * network to say what a function does is a test that reports the network, and
 * that one cost thirty minutes on Windows before it was replaced.
 */
const fixturePath = process.env["FIRST_PUBLISH_FIXTURE"];
const fixture =
  fixturePath === undefined
    ? undefined
    : JSON.parse(readFileSync(fixturePath, "utf8"));

/**
 * Every version the registry serves for a name — `[]` for a name it has never
 * served, and `null` when the question could not be asked.
 *
 * The third state is load-bearing. An offline run that reported `[]` would
 * announce seven first publishes and teach the reader to ignore this file;
 * one that reported "published" would hide the only case it exists for. An
 * unreachable registry is not a negative answer.
 */
const versionsOf = (name) => {
  if (fixture !== undefined) {
    const entry = fixture[name];
    if (entry === undefined) return [];
    return entry.unreachable === true ? null : (entry.versions ?? []);
  }
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (out === "") return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    /* npm answers E404 for a name it has never served. That is an ANSWER —
       "never published" — and it is the whole point of this file. Any other
       failure is the network, and must not be read as an answer. */
    const text = `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`;
    return /E404|404 Not Found|is not in this registry/u.test(text) ? [] : null;
  }
};

/** Exactly the release workflow's rule: not `private` means it ships. */
const publishable = (root) => {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => join(dir, entry, "package.json"))
    .filter((manifest) => existsSync(manifest))
    .map((manifest) => JSON.parse(readFileSync(manifest, "utf8")))
    .filter((pkg) => pkg.private !== true)
    .map((pkg) => String(pkg.name))
    .sort();
};

const main = () => {
  const names = publishable(ROOT);
  /* A reader that found no packages would announce nothing, perfectly. */
  if (names.length < 3) {
    console.error(
      `only ${String(names.length)} publishable package(s) found — the workspace layout moved`,
    );
    return 2;
  }

  const first = [];
  const unknown = [];
  for (const name of names) {
    const versions = versionsOf(name);
    if (versions === null) unknown.push(name);
    else if (versions.length === 0) first.push(name);
  }

  if (unknown.length > 0) {
    console.error(
      `could not ask the registry about: ${unknown.join(", ")}\n` +
        "This is not an answer either way, and it is reported rather than\n" +
        "guessed: an unreachable registry is not the same as a name nobody\n" +
        "has taken.",
    );
    return 2;
  }

  if (first.length === 0) {
    console.log(
      `all ${String(names.length)} publishable packages already exist on the registry; ` +
        "this cut publishes no new name.",
    );
    return 0;
  }

  console.log(
    `${String(first.length)} package(s) would publish for the FIRST time:\n` +
      first.map((name) => `  ${name}`).join("\n") +
      "\n\nThe release will NOT publish these silently. `release.yml` asks the\n" +
      "registry about every name before publishing anything, and a name npm has\n" +
      "never served makes the run exit 1 with the remedy in its error.\n\n" +
      "What it costs is a release that fails AFTER the tag exists: the tag is\n" +
      "pushed before the workflow runs, so getting out means deleting a tag or\n" +
      "cutting the next patch to step past a name nobody meant to publish.\n\n" +
      "Two ways past it, both BEFORE tagging:\n" +
      "  - publish it once by hand (`npm publish --access public`, with 2FA)\n" +
      "    and authorise the workflow with `npm trust github <name> ...`; or\n" +
      '    - mark it `"private": true` so the release does not carry it.',
  );
  return 1;
};

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main());
