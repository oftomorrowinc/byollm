import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRoot, homeRoot, overriddenRootNotice } from "./paths.js";

/**
 * `BYOLLM_HOME` is a test seam and production does not depend on it — B205,
 * ruled 09-15: always or never, and never a silent "sometimes".
 */
const saved = process.env["BYOLLM_HOME"];
afterEach(() => {
  if (saved === undefined) delete process.env["BYOLLM_HOME"];
  else process.env["BYOLLM_HOME"] = saved;
});

describe("where a real device keeps its state", () => {
  it("is ~/.byollm, with nothing in the environment", () => {
    /* B205 item 3, so the default cannot drift. This is the whole production
       contract: no env, no surprises. */
    delete process.env["BYOLLM_HOME"];
    expect(defaultRoot()).toBe(join(homedir(), ".byollm"));
    expect(homeRoot()).toBe(join(homedir(), ".byollm"));
  });

  it("says nothing when nothing has moved", () => {
    delete process.env["BYOLLM_HOME"];
    expect(overriddenRootNotice()).toBeUndefined();
  });

  it("says nothing on a box, where the supervisor states the default", () => {
    /**
     * The case B205's own text gets wrong, and the reason this notice asks
     * whether the ROOT MOVED rather than whether the variable is set.
     *
     * The row justifies the notice as costing nothing because `BYOLLM_HOME` is
     * "never set in prod". `0c16de6` — cited in that same row as the
     * consistency guarantee — has the box supervisor spawn the daemon with
     * `env: {...process.env, BYOLLM_HOME: home}`, unconditionally. A presence
     * check would therefore print a warning on every hosted box, every start,
     * for ever: an operator's first line in the log, always false, in the exact
     * place a real fault has to be noticed.
     */
    process.env["BYOLLM_HOME"] = join(homedir(), ".byollm");
    expect(defaultRoot()).toBe(homeRoot());
    expect(overriddenRootNotice()).toBeUndefined();
  });

  it("speaks up when a real device is pointed somewhere else", () => {
    /* The case the row is actually for: a set value on somebody's own machine,
       which is a bug, and used to be a silent one. */
    process.env["BYOLLM_HOME"] = "/tmp/somewhere-else";
    const notice = overriddenRootNotice();
    expect(notice).toContain("/tmp/somewhere-else");
    expect(notice, "and it names the default it is not").toContain(homeRoot());
  });
});
