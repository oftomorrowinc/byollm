import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every id the contract hands a store is one a real column could hold.
 *
 * The contract's ids were swept to uuids so it could be pointed at a store
 * whose columns are typed — and one was missed, because it was spelled inline
 * in the case that used it instead of being a named constant at the top. The
 * result was a suite that passed against the in-memory store, failed against
 * Postgres on a syntax error, and left site isolation unproven on the
 * implementation that actually routes people's work.
 *
 * The literal was there in plain sight for the whole sweep. What made it
 * invisible was that it *looked* like the others — a quoted string in an
 * argument — and the only thing separating a good one from a bad one is a
 * shape nobody was checking.
 *
 * So this checks the shape, of every id, wherever it is written. Nothing is
 * listed by name: a case added tomorrow that spells an id inline is caught
 * the first time this runs, which is the property a sweep can never have.
 */

const WHOLE_FILE = readFileSync(
  new URL("./store-contract.ts", import.meta.url),
  "utf8",
);

/**
 * Everything except the case that is *about* ids a uuid column cannot hold.
 *
 * One case feeds deliberately malformed ids to ask whether a store can be
 * talked into confusing a site for a user by gluing them together with a
 * separator. Its ids are supposed to be unstorable — that is the hazard it
 * probes — and it is already gated behind `opaqueIds` so a typed store never
 * runs it.
 *
 * Cut by the gate itself rather than by the case's name: if the gate moves,
 * this follows it, and if the gate is removed the case stops being exempt,
 * which is the correct answer in both directions.
 */
const GATE = "it.runIf(options.opaqueIds !== false)(";
const gateAt = WHOLE_FILE.indexOf(GATE);
const SOURCE =
  gateAt === -1
    ? WHOLE_FILE
    : WHOLE_FILE.slice(0, gateAt) +
      WHOLE_FILE.slice(WHOLE_FILE.indexOf("\n    it(", gateAt + GATE.length));

/** The fields whose values reach a store and land in a typed column. */
const ID_FIELDS = ["siteId", "user", "owner", "consentId", "serviceOwner"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("the store contract's ids", () => {
  it("are uuids wherever they are written out", () => {
    const offenders: string[] = [];
    for (const field of ID_FIELDS) {
      // `field: "literal"` — a constant reference has no quotes and is fine,
      // because the constants are asserted separately below.
      const spelled = new RegExp(`\\b${field}:\\s*"([^"]*)"`, "g");
      for (const match of SOURCE.matchAll(spelled)) {
        const value = match[1] ?? "";
        // `owner: null` is a real mapping value and never quoted; an empty
        // string is a deliberate edge case in its own right, not an id.
        if (value === "") continue;
        if (!UUID.test(value)) offenders.push(`${field}: "${value}"`);
      }
    }
    expect(
      offenders,
      "these are handed to a store as ids but could not be stored in a " +
        "`uuid` column, so a real implementation throws instead of answering",
    ).toEqual([]);
  });

  it("are uuids where they are declared as constants", () => {
    const offenders: string[] = [];
    // The named ids at the top of the file: `const NAME = "..."`. Restricted
    // to ones whose value looks like an id attempt, so service names and
    // purposes are not swept in.
    for (const match of SOURCE.matchAll(/const ([A-Z_]+) = "([^"]*)";/g)) {
      const name = match[1] ?? "";
      const value = match[2] ?? "";
      if (!/^(SITE|OWNER|USER|CAROL|OTHER_SITE)$/.test(name)) continue;
      if (!UUID.test(value)) offenders.push(`${name} = "${value}"`);
    }
    expect(offenders).toEqual([]);
  });

  it("exempts the separator case, and only that case", () => {
    // If the gate string ever stops matching, `SOURCE` silently becomes the
    // whole file and this suite starts failing on ids it should ignore —
    // loud, which is the right way round. But the opposite slip is quiet: a
    // cut that swallowed the rest of the file would exempt everything and
    // pass forever, so check the cut kept the cases that follow it.
    expect(WHOLE_FILE.includes(GATE)).toBe(true);
    expect(SOURCE).not.toContain("a:b");
    expect(SOURCE.length).toBeGreaterThan(WHOLE_FILE.length * 0.9);
  });

  it("still catches a bad one", () => {
    // The positive control. A regex that stopped matching would report a
    // clean sweep forever — which is exactly the failure above wearing a
    // different hat, and the reason this file exists at all.
    const spelled = /\bsiteId:\s*"([^"]*)"/g;
    const found = [...'{ siteId: "site_other" }'.matchAll(spelled)].map(
      (match) => match[1] ?? "",
    );
    expect(found).toEqual(["site_other"]);
    expect(UUID.test("site_other")).toBe(false);
  });
});
