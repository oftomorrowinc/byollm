import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The three one-line links that carry a roster to a device — Amendment G.
 *
 * Every one of them is invisible to a unit test and silent when dropped:
 *
 *   1. `connect` writes the control-plane key into the pairing it saves
 *   2. the run loop reads that key back into the Runner
 *   3. the run loop writes the held roster into the pairing file
 *
 * Phase B1 shipped the verification and all three of these unwired. The
 * mechanism had tests, the screen had none, and nothing carried the key from
 * the pair response to the object that checks signatures with it — so a
 * correct implementation did nothing at all on a real device, and said so
 * nowhere.
 *
 * Mutations proved link 2 uncovered even after links 1 and 3 had tests: no
 * unit test of the Runner can see its caller. That is what a source-level
 * check is honestly for, and it is the same tool the canary call sites use.
 */
const src = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("the roster's wiring", () => {
  it("records the control-plane key at pairing", () => {
    // Pairing is the only moment it is offered; a daemon that does not write
    // it down can never verify a roster.
    expect(src("./connect.ts")).toMatch(
      /controlPlanePublic:\s*polled\.controlPlanePublic/,
    );
  });

  it("reads that key back into the runner", () => {
    // Without this the file holds a key nothing consults, and every roster is
    // refused for want of something the device already has.
    expect(src("./cli.ts")).toMatch(
      /controlPlanePublic:\s*pairing\.controlPlanePublic/,
    );
  });

  it("writes the held roster where another process can read it", () => {
    // `byollm status` is a different process from the run loop. A roster only
    // the loop knows about is one nobody can be shown, which is how B1
    // promised to surface it and did not.
    expect(src("./cli.ts")).toMatch(/roster:\s*held/);
    expect(src("./cli.ts")).toContain("runner.heldRoster()");
  });
});
