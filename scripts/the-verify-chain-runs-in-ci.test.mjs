import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Everything `verify` runs, CI runs too — B224.
 *
 * ## The gap this was written for
 *
 * `record-verified.mjs` already checks one direction: jobs that exist ONLY in
 * CI must still be in `ci.yml`, so `verify`'s closing summary cannot describe
 * a job that is gone. It says nothing about the other direction, and **five
 * checks had drifted into `verify.sh` and never reached CI**:
 *
 *   - `generate-about.mjs --check`
 *   - `check:releasing` — B084's runbook gate
 *   - `alpha-claims-match-the-version.mjs` — **B222's launch gate**
 *   - `every-package-ships-its-license.mjs`
 *   - `no-secrets-in-the-tree.mjs`
 *
 * ## Why local-only is not good enough any more
 *
 * The pre-push hook runs `verify`, so every commit *we* push has passed all
 * five. That was a fair argument until 2026-09-18, when the repository turned
 * out to be **already public**: `api.github.com/repos/oftomorrowinc/byollm`
 * answers 200 unauthenticated.
 *
 * A contributor's pull request runs this workflow and never our hook. So CI is
 * the only place these fire on anybody else's commit — and the secret scanner
 * being local-only is exactly backwards, because a stranger's accidental key
 * is the case it exists for. The release workflow also gates on CI rather than
 * on our stamp, so a check CI does not run does not gate a release either.
 *
 * ## The one deliberate exception
 *
 * `record-verified.mjs` writes `.verified`, which its own docstring calls "a
 * fact about this working copy, not about the repository — committing it would
 * let one machine's green vouch for another's". It must NOT run in CI, and
 * that reason is written beside it below rather than left for somebody to
 * rediscover.
 */

const root = new URL("..", import.meta.url);
const verify = readFileSync(
  fileURLToPath(new URL("./verify.sh", import.meta.url)),
  "utf8",
);
const ci = readFileSync(
  fileURLToPath(new URL(".github/workflows/ci.yml", root)),
  "utf8",
);

/**
 * The commands `verify.sh` runs, in order.
 *
 * Lines only — a command inside a comment is prose about the gate, not the
 * gate, and this file has spent the week on that distinction.
 */
const verifySteps = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => line.startsWith("pnpm ") || line.startsWith("node "));

/** Every `- run:` step in the workflow, as whole commands. */
const ciSteps = (text) =>
  [...text.matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gmu)].map(
    (match) => match[1] ?? "",
  );

/**
 * Runs in `verify` and deliberately not in CI, with the reason.
 *
 * A list with no reasons beside it becomes a place to put anything
 * inconvenient, which is how an allowlist stops being a decision.
 */
const LOCAL_ONLY = new Map([
  [
    "node scripts/record-verified.mjs",
    "it stamps THIS working copy; committing or sharing that would let one machine's green vouch for another's",
  ],
]);

describe("the verify chain", () => {
  it("was read at all", () => {
    /* A reader that found no steps would report perfect coverage of an empty
       set, which is the fail-open this repository keeps finding in its own
       checks. */
    expect(verifySteps(verify).length).toBeGreaterThanOrEqual(8);
    expect(ciSteps(ci).length).toBeGreaterThanOrEqual(8);
  });

  it("is run by CI, every step of it", () => {
    const inCi = new Set(ciSteps(ci));
    const missing = verifySteps(verify).filter(
      (step) => !inCi.has(step) && !LOCAL_ONLY.has(step),
    );
    expect(
      missing,
      "these gate our pushes and nobody else's. The repository is public: a " +
        "pull request runs CI and never our pre-push hook, and the release " +
        "workflow gates on CI rather than on our stamp",
    ).toEqual([]);
  });

  it("names a reason for every step it keeps out of CI", () => {
    /* The allowlist cannot grow silently: an entry with no reason is somebody
       making a check optional without saying why. */
    for (const [step, reason] of LOCAL_ONLY) {
      expect(verifySteps(verify), `${step} is not in verify at all`).toContain(
        step,
      );
      expect(reason.length, `${step} has no reason`).toBeGreaterThan(20);
    }
  });

  it("does not keep a step out of CI that CI already runs", () => {
    /**
     * The allowlist rotting the other way: a step exempted years ago that CI
     * has since learned. Harmless today and a lie in the docstring, which is
     * how an exception outlives its reason.
     */
    const inCi = new Set(ciSteps(ci));
    const pointless = [...LOCAL_ONLY.keys()].filter((step) => inCi.has(step));
    expect(
      pointless,
      "CI runs this, so the exemption describes a decision nobody made",
    ).toEqual([]);
  });

  it("compares whole commands, not substrings", () => {
    /**
     * The lesson `record-verified.mjs` already learned and wrote down:
     * `includes()` finds `certify:supabase` inside `certify:supabase-renamed`,
     * so a renamed job reads as still present. Asked directly, because the
     * comparison above is a `Set` and a future edit to `includes` would pass
     * every case in this file.
     */
    const inCi = new Set(ciSteps(ci));
    expect(inCi.has("pnpm run lint")).toBe(true);
    expect(inCi.has("pnpm run lint-renamed")).toBe(false);
    expect(inCi.has("run lint")).toBe(false);
  });
});
