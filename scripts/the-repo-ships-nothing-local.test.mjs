import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Nothing local gets published when this repository does — B224.
 *
 * ## The hazard, found on the checklist before the flip
 *
 * `.claude/` holds whatever the coding agent running in this checkout writes —
 * a scheduled-task lock today, settings or notes tomorrow, some of it carrying
 * local paths. It was covered **only by `.git/info/exclude`**, and that file
 * has two properties that make it the wrong place for this rule:
 *
 * 1. **It is not committed.** It protects one machine. A second checkout, a
 *    contributor, or a fresh clone has no such rule.
 * 2. **It named one filename**, not the directory — so the next file the agent
 *    wrote was one `git add -A` from being staged, and this repository's
 *    history is full of `git add -A`.
 *
 * Neither is a bug in `.git/info/exclude`; it is doing exactly what a local
 * exclude is for. It is the wrong instrument for a rule that has to survive
 * the repository becoming public.
 *
 * ## Why the check reads `.gitignore` specifically
 *
 * Asking git "is this ignored?" would pass on THIS machine, because the local
 * exclude answers yes — and would therefore be green about precisely the
 * arrangement that is wrong. The question is not "is it ignored here"; it is
 * "is the rule in the tree", and only the tracked file can answer that.
 */
/**
 * The RULES, not the file's text.
 *
 * My first version asked whether `.gitignore` contained the string `.claude/`
 * — and two mutations walked through it: narrowing the rule to a single
 * filename still contains the substring, and **deleting the rule entirely**
 * still passes, because the comment block explaining the rule names it in
 * prose.
 *
 * That is the same mistake I had just written a check about on the security
 * docs: *a mention is not a route.* A comment describing an ignore is not an
 * ignore, and a substring match cannot tell them apart. So: comments and blank
 * lines are dropped, and what is left is compared as whole lines.
 */
const rules = readFileSync(".gitignore", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

/** Directories that are one `git add -A` away from being published. */
const LOCAL = [".claude/"];

/**
 * Is this filename credential-shaped?
 *
 * **Two plain conditions rather than one clever pattern**, which is the second
 * time tonight that choice has been forced. A single regex with a lookahead on
 * the segment after `.env` flagged `.env.vercel.example`: the lookahead asked
 * about `vercel` when the question was about the ENDING. `.env.<anything>` is a
 * real environment file; `.env<anything>.example` is a shape file, and only the
 * ending says which.
 *
 * `.npmrc` leads the list because it is the accident this portfolio actually
 * invites — seven packages published under OIDC, and a root `.npmrc` with an
 * `_authToken` is what somebody creates while debugging a publish. `id_rsa` is
 * from somebody else's threat model.
 */
const SHAPE_FILE = /\.(example|sample|template)$/u;
const CREDENTIAL_NAMES =
  /(^|\/)\.npmrc$|(^|\/)\.env($|\.)|\.pem$|\.p12$|\.pfx$|\.jks$|\.key$|id_rsa|(^|\/)credentials?\.json$|service-account[^/]*\.json$/u;

const credentialShaped = (path) =>
  CREDENTIAL_NAMES.test(path) && !SHAPE_FILE.test(path);

describe("local tooling state", () => {
  it("is covered by the tracked .gitignore, not a local exclude", () => {
    for (const dir of LOCAL) {
      expect(
        rules,
        `${dir} is not a rule in .gitignore — a rule in .git/info/exclude ` +
          "protects this machine and nobody else's, and a comment mentioning " +
          "the directory is not a rule either",
      ).toContain(dir);
    }
    /**
     * **And `.npmrc`, which I first asserted only in the ported copies.**
     *
     * The rule went into three repositories and the assertion into two — and
     * the one it was missing from is *this* one, which publishes seven
     * packages under OIDC and is therefore the only repository where a root
     * `.npmrc` holding an `_authToken` is a plausible accident.
     *
     * That is the uneven-application defect CW had just boarded, repeated
     * inside the fix for it, and caught by a mutation that dropped the rule
     * and stayed green.
     */
    expect(
      rules,
      "no `.npmrc` rule — this is the repository that publishes to npm",
    ).toContain(".npmrc");
  });

  it("has never been committed", () => {
    /* The other half: a rule added today does nothing about a file added
       yesterday, and `git rm --cached` is a different repair from an ignore. */
    for (const dir of LOCAL) {
      const tracked = execFileSync("git", ["ls-files", dir], {
        encoding: "utf8",
      }).trim();
      expect(tracked, `${dir} has tracked files`).toBe("");
    }
  });

  it("does not track anything that looks like a credential", () => {
    /**
     * A filename check, deliberately, and it is the weaker half of the sweep.
     *
     * The content sweep — secret shapes across the working tree and all 858
     * commits of history — was run by hand on 2026-09-18 and found nothing but
     * deliberate fixtures (`sk-ant-nope`, `sk-should-not-appear`). That is not
     * something a unit test should re-run on every commit, and GitHub's own
     * secret scanning and push protection are the durable answer once the
     * repository is public.
     *
     * What belongs here is the cheap, fast half: a file whose NAME says it
     * holds a key should never be tracked, because that one is an accident
     * rather than an attack and it is caught for free.
     */
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    const suspicious = tracked
      .split("\n")
      .filter((path) => credentialShaped(path));
    expect(suspicious, "a credential-shaped filename is tracked").toEqual([]);
  });

  it("knows which .env files are conventions and which are secrets", () => {
    /**
     * The control on the pattern, added after the ported copy in
     * `byollm-cloud` flagged a tracked `.env.example` whose first line reads
     * *"Nothing secret belongs in this repository, including in a gitignored
     * file."*
     *
     * A check that flags the deliberate example is a check people learn to
     * override, and the override is what lets the real one through. The
     * exclusion is therefore narrow — the three conventional suffixes — rather
     * than a blanket pass on `.env.*`.
     */
    for (const safe of [
      ".env.example",
      ".env.sample",
      "app/.env.template",
      ".env.vercel.example",
    ]) {
      expect(credentialShaped(safe), safe).toBe(false);
    }
    for (const unsafe of [
      ".env",
      ".env.production",
      ".env.local",
      ".npmrc",
      "deploy/service-account-prod.json",
      "certs/server.key",
    ]) {
      expect(credentialShaped(unsafe), unsafe).toBe(true);
    }
  });
});
