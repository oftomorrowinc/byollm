import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JobStub } from "./job.js";

/**
 * The stub's fields, read out of byollm_009 §6 — cloud_008 §1.5.
 *
 * `stub.test.ts` already enumerates `JobStub`'s keys positively, so a field
 * cannot be added without somebody editing a list. That catches the *silent*
 * addition and misses the one that actually happened twice: the schema and the
 * spec disagreeing while both look deliberate.
 *
 * `site` was on §6's list from the day this spec was frozen and never on the
 * schema. `audienceAllow` was on the schema and never on §6's list. Both
 * survived review, and both were found by a person reading two files side by
 * side and noticing — which is not a control.
 *
 * So this reads the spec. Not a copy of it, not a constant transcribed from it:
 * the file, parsed, at test time. A field added to one side and not the other
 * fails here, and the failure names which side is missing it.
 *
 * The two renames are the interesting part of the maintenance cost, and they
 * are why this is an alias table rather than a set comparison. `jobId`/`id`
 * and `user`/`owner` are the prose reading naturally where the schema reads
 * consistently, and collapsing that difference by editing the frozen spec's
 * normative list would be changing a commitment to make a test pass. The
 * table is asserted to be exhaustive in both directions below, so it cannot
 * quietly absorb a real divergence later.
 */

const SPEC = fileURLToPath(
  new URL(
    "../../../specs/byollm_009-sessions-keys-envelopes.md",
    import.meta.url,
  ),
);

/** What §6 says an upstream can see, straight out of the file. */
function fieldsFromSpec(): string[] {
  const text = readFileSync(SPEC, "utf8");
  const marker = "**Phase 1 — the stub.**";
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`byollm_009 §6 no longer contains ${marker}`);
  }
  const fence = /```\n\{([^}]+)\}\n```/.exec(text.slice(start));
  if (!fence) {
    throw new Error("byollm_009 §6's stub list is no longer a fenced block");
  }
  return fence[1]!
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

/**
 * Spec spelling → schema spelling. Prose names, schema names, same fields.
 *
 * Deliberately tiny and deliberately explicit. Every entry is a place the two
 * documents disagree on a word, and a reader should be able to see all of them
 * at once.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  jobId: "id",
  user: "owner",
});

describe("byollm_009 §6, as the source rather than as a memory", () => {
  const spec = fieldsFromSpec();
  const schema = Object.keys(JobStub.shape);
  const translated = spec.map((field) => ALIASES[field] ?? field);

  it("finds a list to read at all", () => {
    // If the spec is reformatted this fails loudly rather than passing on an
    // empty set — which is how a parse-from-source check turns into the
    // vacuous-green bug it was written to prevent.
    expect(spec.length).toBeGreaterThan(5);
  });

  it("declares exactly the fields the schema carries", () => {
    expect([...translated].sort()).toEqual([...schema].sort());
  });

  it("keeps the alias table honest in both directions", () => {
    // An alias for a field the spec no longer names, or one that maps onto a
    // field the schema no longer has, is drift hiding inside the thing that
    // exists to detect drift.
    for (const [specName, schemaName] of Object.entries(ALIASES)) {
      expect(spec, `alias ${specName} is stale`).toContain(specName);
      expect(schema, `alias → ${schemaName} is stale`).toContain(schemaName);
    }
  });

  it("does not carry membership, on either side", () => {
    // Amendment A's rule, checked where both documents can be wrong at once:
    // a class the router acts on may travel, membership never does.
    expect(translated).not.toContain("audienceAllow");
    expect(schema).not.toContain("audienceAllow");
  });
});
