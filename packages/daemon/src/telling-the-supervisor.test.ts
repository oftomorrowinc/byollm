import { describe, expect, it } from "vitest";
import { supervisorPid, tellSupervisor } from "./supervised.js";

/**
 * B207 — duty three had a listener and no speaker.
 *
 * The box supervisor has handled `SIGHUP` since B185, and nothing in either
 * repo ever sent it: `grep SIGHUP` found the handler and no caller. The box
 * still worked, which is why it went unnoticed for a week — the supervisor
 * respawned a dead daemon every sixty seconds, and the next respawn happened
 * to read the config `setup` had just written. A crutch doing a signal's job.
 */
describe("telling a supervisor that the configuration changed", () => {
  it("says there is nobody to tell, off a box", () => {
    /* The ordinary laptop case, and the one that must stay silent. */
    expect(tellSupervisor(neverCalled, {})).toBe("absent");
  });

  it("signals the pid the supervisor named, and only that one", () => {
    const sent: [number, string][] = [];
    const told = tellSupervisor((pid, signal) => sent.push([pid, signal]), {
      BYOLLM_SUPERVISOR_PID: "1",
    });
    expect(told).toBe("told");
    expect(sent).toEqual([[1, "SIGHUP"]]);
  });

  it("tells a dead supervisor apart from no supervisor at all", () => {
    /**
     * Three outcomes, not two. "You are on a laptop" and "your box's
     * supervisor has died" are different facts about the machine, and a caller
     * that folded them together would print one sentence for both — the shape
     * this project keeps finding, most recently in a daemon `status` that said
     * the same thing about a device that never beat and one that beat and
     * stopped.
     */
    const told = tellSupervisor(
      () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
      { BYOLLM_SUPERVISOR_PID: "4242" },
    );
    expect(told).toBe("gone");
  });

  it("refuses a pid it did not parse, rather than signalling a guess", () => {
    /**
     * The dangerous direction, and why this is an env var rather than an
     * inference.
     *
     * `process.ppid === 1` would have been true for a console child on a box
     * AND for anything run directly under init on an ordinary Linux host —
     * where `SIGHUP` to pid 1 goes to the machine's init system. A value we
     * cannot read is treated as no supervisor at all.
     */
    for (const bad of ["", "0", "-1", "nonsense", "1.5", "  "]) {
      expect(
        supervisorPid({ BYOLLM_SUPERVISOR_PID: bad }),
        bad,
      ).toBeUndefined();
      expect(tellSupervisor(neverCalled, { BYOLLM_SUPERVISOR_PID: bad })).toBe(
        "absent",
      );
    }
  });
});

/** A `kill` that fails the test if anything reaches it. */
const neverCalled = (): never => {
  throw new Error("signalled when there was no supervisor to signal");
};
