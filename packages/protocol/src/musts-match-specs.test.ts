import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUSTS, MUST_IDS, RETIRED_MUSTS } from "./musts.js";

/**
 * Every MUST the specs declare has a registry entry — cloud_008 §1.5.
 *
 * The registry's *entries* were always honest: `verifiedBy` is real data, and
 * the kit already fails if a `conformance`-kind entry has no check. What
 * nothing checked was its **coverage**. byollm_009 §11 declared eleven MUSTs
 * and three had entries; `ROSTER_NOT_DISCLOSED` and `CONSENT_BEFORE_ROUTE`
 * were cited in code comments, tests and two specs as though they were
 * enforced data, and were sentences.
 *
 * Two reviews disagreed about this for a week — one counted entries and found
 * them sound, one counted coverage and found it thin — and both were right
 * about what they measured. The disagreement was possible because neither
 * number was computed. This computes it.
 *
 * **No allowlist.** A known-missing list is the shape Tier 3 exists to delete:
 * a test that asserts the bug as expected, goes green, and stops being read. A
 * MUST declared in a spec table either has an entry or this fails.
 */

const SPECS = fileURLToPath(new URL("../../../specs", import.meta.url));

/**
 * MUST ids declared in any spec's MUST table.
 *
 * A row of a markdown table whose first cell is a backticked SCREAMING_CASE
 * id. That is the shape every spec's §MUSTs table already uses, so this reads
 * what is written rather than asking anyone to write it differently — and a
 * spec that adopts a different shape shows up as a drop in the count below
 * rather than as silence.
 */
function declaredInSpecs(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(SPECS).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(`${SPECS}/${file}`, "utf8");
    for (const line of text.split("\n")) {
      const row = /^\|\s*`([A-Z][A-Z0-9_]{4,})`\s*\|/.exec(line);
      if (!row) continue;
      const id = row[1]!;
      found.set(id, [...(found.get(id) ?? []), file]);
    }
  }
  return found;
}

describe("the registry covers what the specs declare", () => {
  const declared = declaredInSpecs();

  it("finds MUST tables to read", () => {
    // The guard that keeps this from passing vacuously. If the table format
    // changes, or the specs move, this fails rather than reporting perfect
    // coverage of an empty set.
    //
    // Eleven, not thirty-eight, and that gap is a finding rather than a
    // threshold to lower: **byollm_009 is the only spec that declares its
    // MUSTs in a table.** The other 34 registry entries are adjudicated in
    // prose across 001–008, so there is nothing to parse them from. The
    // registry is their only enumerated home, which is exactly the asymmetry
    // that let §11's eleven drift from it unnoticed — recorded as cloud_008
    // §1.3b.
    expect(declared.size).toBeGreaterThanOrEqual(11);
  });

  it("has an entry for every declared MUST", () => {
    const missing = [...declared.keys()]
      .filter((id) => !(id in MUSTS))
      // A retired id may still be named by a spec that has not been revised;
      // it is covered by whatever superseded it, which is the point of
      // recording the succession rather than deleting the name.
      .filter((id) => !(id in RETIRED_MUSTS))
      .sort();

    expect(
      missing,
      missing.length === 0
        ? ""
        : `declared in the specs, absent from the registry: ${missing
            .map((id) => `${id} (${declared.get(id)!.join(", ")})`)
            .join("; ")}`,
    ).toEqual([]);
  });

  it("does not invent a MUST inside the spec that has a table", () => {
    // The other direction, scoped to where it can be asked honestly.
    //
    // It cannot be asked of the registry as a whole: 34 entries are declared
    // in prose, so "declared in no table" would be true of almost all of
    // them and the assertion would be about the specs' formatting rather
    // than about anyone's rules. What *can* be asked is the converse within
    // byollm_009 — every id it sources must be one it declares — which is
    // the drift that actually happened, in both directions, in one spec.
    const sourced = MUST_IDS.filter((id) =>
      MUSTS[id].source.startsWith("byollm_009"),
    );
    const undeclared = sourced.filter((id) => !declared.has(id)).sort();
    expect(
      undeclared,
      undeclared.length === 0
        ? ""
        : `sourced to byollm_009 but absent from its §11 table: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });

  it("points every retired id at a live one", () => {
    for (const [id, record] of Object.entries(RETIRED_MUSTS)) {
      expect(MUST_IDS, `${id} was retired into nothing`).toContain(
        record.supersededBy,
      );
      expect(MUSTS, `${id} is both retired and live`).not.toHaveProperty(id);
    }
  });
});
