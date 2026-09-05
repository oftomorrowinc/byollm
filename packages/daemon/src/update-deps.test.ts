import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, formatVersion } from "./index.js";
import { realUpdateDeps } from "./update-deps.js";

/**
 * The four commands behind the updater — B053.
 *
 * Small on purpose: everything here shells out, so the ordering, the canary
 * and the rollback live in `update.ts` where they can be run. What is worth
 * testing here is the seam where this module reads something another module
 * writes, because that is where it can silently stop working.
 */
function recorder() {
  const ran: string[][] = [];
  const said: string[] = [];
  return {
    ran,
    said,
    deps: (
      answer: (command: readonly string[]) => {
        code: number;
        output: string;
      },
    ) =>
      realUpdateDeps({
        run: (command) => {
          ran.push([...command]);
          return Promise.resolve(answer(command));
        },
        drain: () => Promise.resolve(),
        reregister: () => Promise.resolve(true),
        report: (line) => said.push(line),
      }),
  };
}

describe("installing a version", () => {
  it("names an exact version and never a tag", async () => {
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).install("0.1.0-alpha.83");
    expect(r.ran[0]).toEqual([
      "npm",
      "install",
      "--global",
      "byollm@0.1.0-alpha.83",
    ]);
  });

  it("passes the version as an argument, never through a shell", async () => {
    /* The second of two fences — `exactVersion` has already refused anything
       that is not a literal version. A version string is the argument an
       attacker would most like to see concatenated into a command line, and
       argv means there is nothing left to quote. */
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).install("0.1.0-alpha.83");
    for (const part of r.ran[0] ?? []) {
      expect(part).not.toContain(" ");
      expect(part).not.toContain(";");
    }
  });

  it("keeps npm's own words when the install fails", async () => {
    /* A permissions problem on a system prefix reads nothing like a registry
       outage, and both are somebody's to fix. Our reading of it would throw
       away the line that tells them apart — the same rider the supervisor
       refusal took. */
    const r = recorder();
    const ok = await r
      .deps(() => ({ code: 243, output: "npm ERR! EACCES: permission denied" }))
      .install("0.1.0-alpha.83");
    expect(ok).toBe(false);
    expect(r.said.join("")).toContain("EACCES");
    expect(r.said.join("")).toContain("243");
  });
});

describe("asking the installed binary what it is", () => {
  it("reads the version out of what `--version` actually prints", () => {
    /**
     * The coupling worth a test. This reads a string another module writes,
     * and if `formatVersion` is reworded into a shape the pattern misses,
     * the canary reports `undefined` on a perfectly good install — so every
     * update in the fleet rolls back, and nothing anywhere says why.
     *
     * So the fixture is the real function's real output, not a string typed
     * here to match the regex.
     */
    const printed = formatVersion();
    const found = /^byollm (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(printed);
    expect(found?.[1], `pattern missed: ${JSON.stringify(printed)}`).toBe(
      DAEMON_VERSION,
    );
  });

  it("finds it through the deps, from the same output", async () => {
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 0, output: formatVersion() }))
      .installedVersion();
    expect(reported).toBe(DAEMON_VERSION);
  });

  it("says nothing when the binary will not run", async () => {
    /* `undefined` here is a failed canary, not a third state: this runs
       immediately after an install, so "cannot say" means the thing just
       installed does not answer. */
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 127, output: "" }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });

  it("says nothing when the output carries no version at all", async () => {
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 0, output: "byollm (development build)\n" }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });

  it("never mistakes another version on the line for byollm's", async () => {
    /**
     * Found by mutation. The first draft took the first semver-shaped token
     * anywhere in the output, so a reworded first line made it match `node
     * 24.18.0` from the SECOND line — and report node's version as the
     * daemon's. That is not a failed canary but a confidently wrong one:
     * every machine rolls back, and the message says the binary reports
     * 24.18.0.
     */
    const r = recorder();
    const reported = await r
      .deps(() => ({
        code: 0,
        output: "byollm build 0_1_0 (protocol 1)\ndarwin-arm64, node 24.18.0\n",
      }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });
});

describe("re-registering", () => {
  it("runs start, because the entry point moved", async () => {
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).reregister();
    expect(r.ran[0]).toEqual(["byollm", "start"]);
  });

  it("is false when the supervisor refused", async () => {
    const r = recorder();
    expect(await r.deps(() => ({ code: 1, output: "" })).reregister()).toBe(
      false,
    );
  });
});
