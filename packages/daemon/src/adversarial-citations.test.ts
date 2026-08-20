import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSTS, kindsOf } from "@byollm/protocol";
import { describe, expect, it } from "vitest";

/**
 * Every `adversarial` MUST is cited by a test that runs — V1-15.
 *
 * The registry has four `verifiedBy` kinds, and three of them are counted by
 * something: `conformance` is cross-checked against the kit's `musts` arrays,
 * `construction` is a claim about a type or a schema, `operator` is
 * deliberately unmechanised and says so. `adversarial` was counted by nothing
 * at all — it means "the reference daemon's own hostile suites prove this",
 * and nothing asked whether any of them mentioned it.
 *
 * That is the same shape as the registry drift the conformance cross-check
 * exists to catch: a claim about coverage with no reader. `SITE_KEY_BY_STUB`
 * was the specimen — its own registry comment explains that the honest paths
 * pass with every site check deleted, so the only thing standing between it
 * and being unverified is a hostile pairing of stub and envelope, and no test
 * naming it existed.
 *
 * ## What this can and cannot prove
 *
 * It proves a **citation**, not an enforcement: a test can name a MUST in its
 * title and assert nothing about it. What makes the citation worth something
 * is `MUTATIONS.md` — the file that requires the *smallest change that must
 * make it fail* to be recorded. This check is the cheap half, and the cheap
 * half is what stops a MUST from being classified into a category nobody
 * reads.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const roots = [here, join(here, "..", "test", "adversarial")];

/** Every test file the daemon's own suites run. */
function testSources(): string[] {
  const sources: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
      sources.push(readFileSync(join(root, entry.name), "utf8"));
    }
  }
  return sources;
}

describe("the adversarial kind, counted", () => {
  it("has a test naming every MUST that claims it", () => {
    const sources = testSources();
    const adversarial = Object.values(MUSTS)
      .filter((must) => kindsOf(must).includes("adversarial"))
      .map((must) => must.id);

    // Sanity, and not a formality: if this list is ever empty the assertion
    // below passes while proving nothing, which is the failure mode this
    // whole file is about.
    expect(adversarial.length).toBeGreaterThan(0);

    const uncited = adversarial.filter(
      (id) => !sources.some((source) => source.includes(id)),
    );
    expect(uncited, "adversarial MUSTs no test names").toEqual([]);
  });
});
