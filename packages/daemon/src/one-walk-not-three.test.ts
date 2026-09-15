import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { treeOf } from "./test-support.js";

/**
 * A recursive walk goes through {@link treeOf} — B209, and this check exists
 * because the prediction that made it is a prediction.
 *
 * Three call sites across two files each walked a tree recursively and then
 * matched the platform's own names against literals written with `/`. On Windows every one of those tests
 * silently matched nothing: our `specs/` was read as a published surface and
 * reported 17 retired verbs that are deliberately history, and the entry-point
 * list came back empty so every export read as an orphan. Four days of red, on
 * one platform, invisible everywhere else.
 *
 * Fixing the three and moving on would leave the next walk to be written the
 * way the first three were. **The separator is not the bug; assuming one is.**
 */
const DAEMON = fileURLToPath(new URL("./", import.meta.url));

/**
 * The needle, assembled at runtime so this file cannot match itself.
 *
 * Written as one literal it would appear in its own source and in the sentence
 * above explaining it, and the check would report the file that enforces the
 * rule. **That is not hypothetical:** a source-scanning test written earlier
 * today failed against its own explanatory comment, because a grep cannot tell
 * code from the prose describing it.
 */
const WALKS = new RegExp(
  ["readdirSync", "\\([^)]*", "recursive"].join(""),
  "s",
);

/** Where the rule itself lives, and the only place allowed to break it. */
const HOME = "test-support.ts";

/**
 * **Scoped to `packages/daemon`, and the bound is stated rather than implied.**
 *
 * Four more suites walk trees recursively — in `server`, `protocol` and
 * `relay`. None is broken today: every one filters on `.ts` and `.test.` only,
 * neither of which contains a separator. They are latent, not faulty.
 *
 * They are NOT converted because `treeOf` lives in the daemon's test support,
 * and importing it from `protocol` would make the lowest-level package depend
 * on the highest — a worse defect than the one being prevented. A shared
 * test-utility home is the fix, and it is a decision rather than a tidy-up.
 *
 * So this rule covers the package it can cover, and says out loud that it does
 * not cover the other three. A check that quietly stopped at a package
 * boundary would be the "searched part of the tree" half of instruction 31.
 */
describe("walking a tree in a test", () => {
  const testFiles = treeOf(DAEMON)
    .filter(
      (file) =>
        file.relative.endsWith(".test.ts") &&
        !file.relative.includes("node_modules") &&
        !file.relative.includes("/dist/") &&
        !file.relative.includes("/.tsbuild/"),
    )
    .map((file) => ({
      name: file.relative,
      text: readFileSync(file.path, "utf8"),
    }));

  it("reads the suites at all, or it is a rule about nothing", () => {
    /* The control, and the reason it is first: an empty list satisfies the
       assertion below perfectly. A check whose success and whose blindness
       look identical is the failure this whole row is about. */
    expect(testFiles.length).toBeGreaterThan(40);
    expect(
      testFiles.some((file) => file.name.includes("exported-tested-never")),
      "and reaches the files that actually do this",
    ).toBe(true);
  });

  it("goes through treeOf, so the separator is assumed in one place", () => {
    const own = testFiles.filter(
      (file) => WALKS.test(file.text) && !file.name.endsWith(HOME),
    );
    expect(
      own.map((file) => file.name),
      "walk a tree with treeOf() from test-support — it hands back `/` names " +
        "on every platform, which is the thing three files got wrong at once",
    ).toEqual([]);
  });
});
