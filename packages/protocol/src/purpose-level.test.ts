import { describe, expect, it } from "vitest";
// Through the package entry, so a name the hub and the dashboard will import
// and that is not exported fails here, not in their builds.
import {
  DEFAULT_LEVEL,
  LEVELS_STRONGEST_FIRST,
  Manifest,
  Purpose,
  PurposeLevel,
  levelOf,
} from "./index.js";

/**
 * A purpose's level — #10711, ruled by Todd on #10860, points 1, 9 and 10.
 *
 * "A purpose in a site's manifest may carry a level: Quick, Everyday,
 * Complex or Hardest. It never carries a model's name. No level means
 * Everyday."
 */
describe("a purpose's level", () => {
  const purpose = { label: "Writing Assistant", kinds: ["llm.chat"] };

  it("parses each of the four and keeps the key", () => {
    for (const level of ["quick", "everyday", "complex", "hardest"]) {
      const parsed = Purpose.parse({ ...purpose, level });
      expect(parsed.level, `${level} was refused or changed`).toBe(level);
      expect(levelOf(parsed)).toBe(level);
      expect(
        Manifest.parse({ writing: { ...purpose, level } })["writing"]?.level,
      ).toBe(level);
    }
  });

  it("refuses any other word, and the refusal names the four", () => {
    for (const notALevel of ["medium", "Quick", "HARDEST", "easy", "", 3]) {
      const result = Purpose.safeParse({ ...purpose, level: notALevel });
      expect(
        result.success,
        `${JSON.stringify(notALevel)} is not a level and was accepted`,
      ).toBe(false);
      const issue = result.error?.issues.find(
        (i) => i.path.join(".") === "level",
      );
      expect(issue?.message).toBe(
        "a level is one of quick, everyday, complex or hardest",
      );
    }
  });

  it("is not added at parse to a purpose that names none", () => {
    /* A `.default("everyday")` would be invisible on the input side. Only
       the output says whether the key was invented. */
    const parsed = Purpose.parse(purpose);
    expect(Object.hasOwn(parsed, "level")).toBe(false);
    const manifest = Manifest.parse({ writing: purpose });
    expect(Object.hasOwn(manifest["writing"] ?? {}, "level")).toBe(false);
  });

  it("answers a purpose that names none as everyday, in one place", () => {
    expect(levelOf(Purpose.parse(purpose))).toBe("everyday");
    expect(DEFAULT_LEVEL).toBe("everyday");
  });

  it("states the order once, strongest first", () => {
    /* Written out rather than derived from the enum: the enum's order is
       declaration order, and the thing pinned here is the ruled order the
       hub and the dashboard will both read. Reordering the constant, or
       dropping a level from it, fails this. */
    expect([...LEVELS_STRONGEST_FIRST]).toEqual([
      "hardest",
      "complex",
      "everyday",
      "quick",
    ]);
    // Every level is in the order exactly once.
    expect([...LEVELS_STRONGEST_FIRST].sort()).toEqual(
      [...PurposeLevel.options].sort(),
    );
    // And nobody downstream can reorder it in place.
    expect(Object.isFrozen(LEVELS_STRONGEST_FIRST)).toBe(true);
  });
});
