import { Manifest } from "@byollm/protocol";
import { Manifest as Manifest017 } from "byollm-protocol-0.1.7";
import { describe, expect, it } from "vitest";

/**
 * A purpose's level, against `@byollm/protocol` 0.1.7 as published on npm
 * (installed under an alias so it cannot be confused with this tree's) —
 * #10711, ruled by Todd on #10860, point 9.
 *
 * The fact the ruling's order rests on. `Purpose` is `.strict()`, so a
 * reader built on 0.1.7 refuses a manifest whose purpose carries `level`.
 * That is why the order is: the mapping table's migration, this protocol
 * published, the hub's pin, then the dashboard's, and only then may sites
 * add levels. If this ever goes green the other way, the order can relax;
 * until then it cannot.
 */
describe("a purpose's level against the published 0.1.7 protocol", () => {
  const withLevel = {
    writing: { label: "Writing", kinds: ["llm.chat"], level: "complex" },
  };
  const withoutLevel = {
    writing: { label: "Writing", kinds: ["llm.chat"] },
  };

  it("0.1.7's Manifest refuses a purpose that carries a level", () => {
    const old = Manifest017.safeParse(withLevel);
    expect(old.success).toBe(false);
    // Refused for the key, not for something else about the manifest.
    expect(
      old.error?.issues.some(
        (issue) =>
          issue.code === "unrecognized_keys" &&
          JSON.stringify(issue).includes("level"),
      ),
    ).toBe(true);
  });

  it("this tree's Manifest accepts it, and both accept a manifest without one", () => {
    expect(Manifest.safeParse(withLevel).success).toBe(true);
    expect(Manifest017.safeParse(withoutLevel).success).toBe(true);
    expect(Manifest.safeParse(withoutLevel).success).toBe(true);
  });
});
