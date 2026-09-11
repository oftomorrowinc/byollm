import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gigabytes } from "./memory-gate.js";

/**
 * One way to render memory, and it rounds the other way — B167.
 *
 * Four copies of this lived in the daemon, and `cli.ts` held the same three
 * lines **twice, in two functions**. B072's shape on a different quantity —
 * and the quantity is different in the way that matters.
 *
 * `describeBytes` in the protocol rounds UP, because it answers *"how much do
 * I have to lose"*: an answer smaller than the truth sends somebody to trim a
 * hundred bytes off something that needs to lose a megabyte.
 *
 * Everything here answers *"how much do I have"*, where **an answer larger
 * than the truth is the dangerous one.**
 *
 * That is why B074 deliberately did NOT widen the message-size check over this
 * code: one check asserting one rule over two opposite decisions is the
 * mistake that file exists to prevent.
 */
describe("how the daemon says a gigabyte", () => {
  it("never reports more memory than there is", () => {
    /**
     * The case, exactly: one byte under the 2 GB floor.
     *
     * `toFixed` prints `2.0 GB` for it — **a screen saying a device has
     * precisely the memory it was just refused for**, beside a refusal that
     * says the floor is 2 GB. The reader is left with two numbers that agree
     * and an outcome that contradicts them.
     */
    const floor = 2 * 1024 ** 3;
    expect(gigabytes(floor - 1)).not.toBe(gigabytes(floor));
    expect(Number.parseFloat(gigabytes(floor - 1))).toBeLessThan(2);
  });

  it("still shows a clean number when it is one", () => {
    // The control: flooring must not turn 2 GB into 1.9 GB, or every healthy
    // reading looks like a near miss.
    expect(gigabytes(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(gigabytes(0)).toBe("0.0 GB");
  });

  it("rounds the opposite way from the protocol, on purpose", () => {
    /* Stated as its own case because the two rules look like a contradiction
       until you know which question each answers. A future reader "fixing"
       one to match the other would break exactly one of them. */
    const justOver = 1.96 * 1024 ** 3;
    expect(gigabytes(justOver)).toBe("1.9 GB");
  });
});

describe("where memory may be rendered", () => {
  const SRC = fileURLToPath(new URL("./", import.meta.url));

  /** Daemon source, comments stripped — prose must stay able to explain this. */
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

  it("has sources to read, or this checks nothing", () => {
    expect(sources().length).toBeGreaterThan(10);
  });

  it("is only in `gigabytes` — nobody else labels a number GB", () => {
    /**
     * Narrow on purpose, and B074 is why: a bare `toFixed` here would flag
     * `spend.ts` and `cli.ts` formatting DOLLARS, which is a third quantity
     * with a third argument. What must not be duplicated is the rendering of
     * a byte count as GB, so the pattern is a `toFixed` whose output is
     * labelled `GB`.
     *
     * Its limit, stated rather than discovered: a spelling that puts the
     * label on another line escapes. All four copies that existed were on one
     * line, and a check that catches the shape people actually write beats one
     * that catches nothing while claiming everything.
     */
    const offenders = sources()
      .filter(({ name }) => name !== "memory-gate.ts")
      .filter(({ text }) => /toFixed\s*\([^)]*\)[^\n]{0,12}GB/.test(text))
      .map(({ name }) => name);
    expect(
      offenders,
      "rendering memory belongs to `gigabytes`; a second copy is how four of " +
        "them appeared, two in one file",
    ).toEqual([]);
  });
});
