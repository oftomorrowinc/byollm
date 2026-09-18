import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No test writes `BYOLLM_SUPERVISOR_PID` onto the process — B241.
 *
 * ## The failure, measured
 *
 * Two files did, and it cost 8% of paired runs:
 *
 *     setup.test.ts + start-says-what-is-signed-out.test.ts
 *       in parallel      25 runs   2 red
 *       sequential       25 runs   0 red
 *       after the fix    25 runs   0 red
 *
 * `start-says-what-is-signed-out.test.ts` set the variable to announce a
 * supervisor; `setup.test.ts`'s supervisor cases read it. **vitest's worker
 * threads share `process.env`**, so each file was configuring the other's
 * tests, and whichever one lost the race hung for five seconds waiting on a
 * supervisor that was never going to answer it.
 *
 * Both files were careful. Both saved and restored. Save-and-restore cannot
 * help, because the other file is writing *between* the save and the read —
 * which is exactly why this is a check about the mutation rather than about
 * the restoring.
 *
 * ## Why a source check rather than a runtime one
 *
 * The damage is done by a file this test may never share a worker with, and it
 * is done at a moment no assertion is watching. Reading the source is the only
 * way to catch the WRITE rather than one of its victims — and it catches the
 * next file too, which is the point: `runCli` and `runSetup` both take an
 * `env` now, so there is a seam and no reason to reach past it.
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every test file in this package. */
function testFiles() {
  return readdirSync(SRC).filter((name) => name.endsWith(".test.ts"));
}

describe("the supervisor variable", () => {
  it("finds test files to check, or this checks nothing", () => {
    expect(testFiles().length).toBeGreaterThan(10);
  });

  it("is never written onto `process.env` by a test", () => {
    /**
     * Assignment and deletion both, because both are announcements. The
     * control case's `delete process.env[...]` was the other half of the race:
     * it told every file in the worker "there is no supervisor", and was
     * itself overwritten by a sibling saying there was one.
     */
    const offenders: string[] = [];
    for (const name of testFiles()) {
      if (name === "no-test-announces-a-supervisor.test.ts") continue;
      const source = readFileSync(join(SRC, name), "utf8");
      for (const line of source.split("\n")) {
        const touches =
          /process\.env\[["']BYOLLM_SUPERVISOR_PID["']\]\s*=/.test(line) ||
          /delete\s+process\.env\[["']BYOLLM_SUPERVISOR_PID["']\]/.test(line);
        if (touches) offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      "a test is announcing a supervisor to every other test in its worker — " +
        "`runCli` and `runSetup` both take an `env`, so hand them one instead",
    ).toEqual([]);
  });

  it("is still reachable through the seam, or the fix removed the ability", () => {
    /**
     * The control on the rule above. A check that only forbids would be
     * satisfied by nobody testing the supervisor at all — and the supervisor
     * path is B207, which exists because a box picked up config a minute late.
     *
     * So: somebody must still be exercising it, through the injected
     * environment rather than the global one.
     */
    const injected = testFiles().filter((name) =>
      readFileSync(join(SRC, name), "utf8").includes("BYOLLM_SUPERVISOR_PID:"),
    );
    expect(
      injected.length,
      "nothing exercises the supervisor path any more",
    ).toBeGreaterThan(0);
  });
});
