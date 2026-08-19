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
    // Normalised for the reason `docs-match-code.test.ts` gives at length: a
    // CRLF checkout makes a `\n`-anchored pattern match nothing, and a
    // coverage test that parses no tables reports perfect coverage.
    const text = readFileSync(`${SPECS}/${file}`, "utf8").replace(
      /\r\n/g,
      "\n",
    );
    // Split on either ending — a Windows checkout is CRLF, and a stray `\r`
    // at the end of a row is invisible until an id lands beside it.
    for (const line of text.split(/\r?\n/)) {
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
    // It used to say eleven, because byollm_009 was the only spec with a
    // table and the other 34 entries were adjudicated in prose — so the
    // registry was their only enumerated home, which is the asymmetry that
    // let §11's own eleven drift from it unnoticed. cloud_008 Tier 4 §1.3b
    // gave 001, 002, 004 and 007 tables of their own.
    expect(declared.size).toBeGreaterThanOrEqual(MUST_IDS.length);
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

  it("declares every registry entry in some spec", () => {
    // The direction that catches a rule with no author: a MUST invented in
    // code, enforced by it, and adjudicated nowhere. Askable across the whole
    // registry now that every spec has a table — it was scoped to byollm_009
    // before, and even scoped it found three orphans on its first run.
    const orphans = MUST_IDS.filter((id) => !declared.has(id)).sort();
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `in the registry, declared in no spec table: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("declares each MUST in exactly one spec", () => {
    // Two homes is two places to revise and one to forget. The tables index
    // rather than restate, so a duplicate is cheap to create and invisible
    // until somebody edits the copy nobody reads.
    const twice = [...declared.entries()]
      .filter(([, files]) => new Set(files).size > 1)
      .map(([id, files]) => `${id} (${[...new Set(files)].join(", ")})`)
      .sort();
    expect(twice, twice.join("; ")).toEqual([]);
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
