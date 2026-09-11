import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A sealed outcome is opened in one place — B107, and B092 set the precedent.
 *
 * `openSealedOutcome` decrypts, parses and validates in one function so that
 * every caller gets the same answer to *"is this envelope real"*. Two callers
 * use it today and nothing keeps it that way: a third site reaching for
 * `SealedOutcome.safeParse` directly would work, pass its own tests, and skip
 * whatever this function does around the parse.
 *
 * **The property is an absence, and what breaks it is a line somebody adds** —
 * so it is read from the source, exactly as `spawnServer`'s guard is. A test
 * that could only observe it by constructing a bad envelope would be testing
 * the parser rather than the topology.
 */
const SRC = fileURLToPath(new URL("./", import.meta.url));

function sources(): { name: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => ({
      name,
      text: readFileSync(`${SRC}${name}`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " "),
    }));
}

describe("where a sealed outcome may be opened", () => {
  it("has sources to read, or this checks nothing", () => {
    /* The control every check in this repository has learned to carry: a
       scan that finds no files reports success about nothing. */
    expect(sources().length).toBeGreaterThan(5);
  });

  it("is only `sealed-outcome.ts` — nobody else parses the envelope", () => {
    const offenders = sources()
      .filter(({ name }) => name !== "sealed-outcome.ts")
      .filter(({ text }) =>
        /SealedOutcome\s*\.\s*(safeParse|parse)\b/.test(text),
      )
      .map(({ name }) => name);
    expect(
      offenders,
      "opening a seal belongs to `openSealedOutcome`; a second parse site is " +
        "a second answer to whether an envelope is real",
    ).toEqual([]);
  });

  it("and it still has callers, or the rule guards nothing", () => {
    /**
     * The half that makes the rule meaningful rather than merely true.
     *
     * "Only one parse site" is trivially satisfied by zero parse sites, and a
     * function nobody calls is the seam B103 is about. This is the same shape
     * as that row, asserted here so the two cannot both go quiet: the rule
     * above says *nowhere else*, and this says *somewhere*.
     */
    const callers = sources()
      .filter(({ name }) => name !== "sealed-outcome.ts")
      .filter(({ text }) => /openSealedOutcome\s*\(/.test(text))
      .map(({ name }) => name);
    expect(callers.length).toBeGreaterThan(0);
  });
});
