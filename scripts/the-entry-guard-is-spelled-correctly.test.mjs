import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A script that guards its entry point guards it correctly — B224.
 *
 * ## The fail-open, which shipped three times before anybody saw it
 *
 * These scripts end with a guard so importing one does not run it:
 *
 *     if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
 *
 * The obvious spelling uses `resolve` instead, and it is wrong in a way that
 * is invisible: **`import.meta.url` reports the REAL path and `process.argv[1]`
 * does not.** Under a symlinked checkout — `/tmp` on macOS is one, being a
 * symlink to `/private/tmp` — the two never match, the guard decides this file
 * is not the entry point, and `main()` never runs.
 *
 * So the script **exits 0 having read nothing**. Not a crash, not a refusal: a
 * green. Three gates in this portfolio shipped that before it was noticed, and
 * a gate that silently does nothing is worse than no gate, because the chain
 * it sits in reports success.
 *
 * ## Why the form and not the behaviour
 *
 * The honest check would run each script and watch it do something. **That is
 * not available here and the reason is written in blood**: running every script
 * in a directory to see whether it starts is what put the production hub into
 * maintenance mode on 2026-09-19. `bump-version.mjs` rewrites every manifest
 * it finds; `tag.sh` tags. An operator script acts on being invoked, and this
 * directory is full of them.
 *
 * So the form is compared, and the limit is stated rather than hidden: this
 * proves the guard is spelled correctly, not that the script works.
 */

const DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * A script with its prose removed.
 *
 * **The first version of this file read the whole source**, and the scripts
 * that get this right explain why in a docstring — so the first line matching
 * `process.argv[1]` was a *paragraph about the bug*, not the guard. The check
 * then reported the comment as a malformed guard.
 *
 * A mention is not a route, arriving in the third check today written to
 * enforce exactly that. Coverage is asked of the CODE; the prose is where the
 * reasoning lives and it is allowed to name what it is reasoning about.
 */
const code = (source) =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/^[ \t]*\/\/.*$/gmu, "");

/** Every script here that decides whether it is the entry point. */
const guarded = () =>
  readdirSync(DIR)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => ({
      name,
      source: code(
        readFileSync(new URL(name, new URL(".", import.meta.url)), "utf8"),
      ),
    }))
    .filter(({ source }) => /process\.argv\[1\]/u.test(source))
    .map(({ name, source }) => ({
      name,
      line:
        source.split("\n").find((line) => line.includes("process.argv[1]")) ??
        "",
    }));

describe("the entry-point guard", () => {
  it("is found in the scripts that have one", () => {
    /* A reader that matched nothing would report every script correct, which
       is the same shape as the defect it is looking for. */
    expect(guarded().length).toBeGreaterThanOrEqual(3);
  });

  it("resolves the real path on both sides, in every script", () => {
    /**
     * `realpathSync` on the argv side, because `import.meta.url` is already
     * real. Comparing a resolved-but-not-real path against a real one is the
     * fail-open: it is false under any symlinked checkout, and false means
     * "do nothing and exit 0".
     */
    const wrong = guarded().filter(
      ({ line }) => !line.includes("realpathSync(process.argv[1]"),
    );
    expect(
      wrong.map(({ name }) => name),
      "this guard is false under a symlinked checkout, and a false guard means " +
        "the script exits 0 having done nothing — `resolve` is not `realpathSync`",
    ).toEqual([]);
  });

  it("compares against import.meta.url rather than a hand-built path", () => {
    /* The other half of the comparison. A guard that rebuilt the expected
       path from `__dirname` and a filename would drift the day a script is
       renamed, and drift the same silent way. */
    for (const { name, line } of guarded()) {
      expect(
        line,
        `${name} does not compare against import.meta.url`,
      ).toContain("fileURLToPath(import.meta.url)");
    }
  });
});
