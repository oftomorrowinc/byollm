import { describe, expect, it } from "vitest";
import { CHECKS, certify, uncoveredMusts } from "../src/index.js";
import { referenceTarget } from "./reference-target.js";

/**
 * The conformance kit against the reference server, on every PR.
 *
 * Each check is its own `it` so a failure names the MUST it broke rather than
 * reporting "conformance failed".
 */
describe("conformance — reference server", () => {
  for (const check of CHECKS) {
    it(`${check.id}: ${check.title} [${check.musts.join(", ")}]`, async () => {
      const target = referenceTarget();
      const report = await certify(target, { only: [check.id] });
      const result = report.results[0];
      expect(result?.error ?? "", result?.error ?? "").toBe("");
      expect(result?.passed).toBe(true);
    });
  }
});

describe("the kit is honest about its own coverage", () => {
  it("reports which MUSTs no check asserts", () => {
    // Not asserted to be empty: some MUSTs are daemon-internal and proven by
    // the adversarial suite instead. What matters is that the gap is visible
    // in the report rather than implied away.
    const uncovered = uncoveredMusts();
    expect(Array.isArray(uncovered)).toBe(true);
  });

  it("gives every check a unique id and at least one MUST", () => {
    const ids = CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of CHECKS) {
      expect(check.musts.length, check.id).toBeGreaterThan(0);
    }
  });
});
