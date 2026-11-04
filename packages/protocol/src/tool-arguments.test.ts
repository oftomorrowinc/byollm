import { describe, expect, it } from "vitest";
import { ToolParameters, toolArgumentsRefusal } from "./tools.js";

/**
 * A call's arguments against its declaration — byollm_012 §3, C036's rule.
 *
 * The subset is small so that this can check all of it. Each case is one
 * rule of §3, accepted at its edge and refused one step past it.
 */
const parameters = ToolParameters.parse({
  type: "object",
  properties: {
    query: { type: "string", maxLength: 8 },
    mode: { type: "string", maxLength: 8, enum: ["fast", "slow"] },
    count: { type: "integer", minimum: 1, maximum: 5 },
    weight: { type: "number", maximum: 1 },
    exact: { type: "boolean" },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 3 },
      maxItems: 2,
    },
  },
  required: ["query"],
});

const refused = (args: Record<string, unknown>) =>
  toolArgumentsRefusal(parameters, { query: "ok", ...args });

describe("toolArgumentsRefusal", () => {
  it("accepts arguments that fit, at every edge", () => {
    expect(
      refused({
        query: "12345678",
        mode: "slow",
        count: 5,
        weight: 1,
        exact: false,
        tags: ["abc", "de"],
      }),
    ).toBeNull();
  });

  it.each([
    [{ sneaky: 1 }, '"sneaky" is not a parameter of this tool'],
    [{ query: "123456789" }, '"query" must be at most 8 characters'],
    [{ query: 7 }, '"query" must be a string'],
    [{ mode: "medium" }, '"mode" must be one of "fast", "slow"'],
    [{ count: 1.5 }, '"count" must be an integer'],
    [{ count: 0 }, '"count" must be at least 1'],
    [{ count: 6 }, '"count" must be at most 5'],
    [{ weight: "1" }, '"weight" must be a number'],
    [{ weight: Number.NaN }, '"weight" must be a number'],
    [{ exact: "yes" }, '"exact" must be true or false'],
    [{ tags: "abc" }, '"tags" must be an array'],
    [{ tags: ["a", "b", "c"] }, '"tags" must have at most 2 items'],
    [{ tags: ["abcd"] }, '"tags" item 0 must be at most 3 characters'],
  ])("refuses %j", (args, why) => {
    expect(refused(args)).toBe(why);
  });

  it("refuses a missing required argument", () => {
    expect(toolArgumentsRefusal(parameters, {})).toBe('"query" is required');
  });

  it("does not read a prototype key as a declared parameter", () => {
    expect(refused({ toString: "x" })).toBe(
      '"toString" is not a parameter of this tool',
    );
  });
});
