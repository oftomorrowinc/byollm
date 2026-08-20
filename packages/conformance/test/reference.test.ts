import { describe, expect, it } from "vitest";
import {
  CHECKS,
  certify,
  miscoveredMusts,
  uncoveredMusts,
} from "../src/index.js";
import { MUSTS, MUST_IDS, kindsOf } from "@byollm/protocol";
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
  it("asserts every MUST it is able to assert", () => {
    // This used to check only that the result was an array, which is a thing
    // that cannot fail. It could not do better while the count mixed in
    // MUSTs the kit is structurally unable to test — a number that can never
    // reach zero gets ignored. Now that each MUST declares how it is
    // verified, this counts only `conformance`-kind gaps, and that number
    // must be zero.
    expect(uncoveredMusts()).toEqual([]);
  });

  it("never claims a MUST that conformance cannot verify", () => {
    // The opposite failure, and the quieter one: a check listing an
    // `operator`-kind MUST would put "verified" beside something no third
    // party can check from outside. That is how "byollm-compatible" comes to
    // cover claims the kit never touched.
    expect(miscoveredMusts()).toEqual([]);
  });

  it("gives every MUST at least one verification kind, and only real ones", () => {
    const KINDS = ["conformance", "adversarial", "construction", "operator"];
    for (const id of MUST_IDS) {
      const kinds = kindsOf(MUSTS[id]);
      // At least one, because an empty list would pass a `every` check while
      // claiming nothing — the vacuity this file exists to refuse.
      expect(kinds.length, id).toBeGreaterThan(0);
      for (const kind of kinds) expect(KINDS, id).toContain(kind);
    }
  });

  it("gives every check a unique id and at least one MUST", () => {
    const ids = CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of CHECKS) {
      expect(check.musts.length, check.id).toBeGreaterThan(0);
    }
  });
});
