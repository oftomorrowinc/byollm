import { describe, expect, it } from "vitest";
import { howItRuns, supervisorPid, tellSupervisor } from "./supervised.js";

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
    const told = tellSupervisor(
      (pid, signal) => sent.push([pid, signal]),
      { BYOLLM_SUPERVISOR_PID: "1" },
      /* Stated, not inherited: on Windows this correctly refuses, and a case
         about what a signal does must not quietly become a case about the
         runner's platform. */
      "linux",
    );
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
      "linux",
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
      expect(
        tellSupervisor(neverCalled, { BYOLLM_SUPERVISOR_PID: bad }, "linux"),
      ).toBe("absent");
    }
  });

  it("refuses on Windows, where a signal is a kill", () => {
    /**
     * `process.kill(pid, "SIGHUP")` on win32 does not deliver a signal — it
     * **terminates the target process**. A supervised box is Linux, so this
     * cannot arise from our own code; it would take the variable being set by
     * hand, and the cost of being wrong is killing whatever process that
     * number names.
     *
     * The platform that cannot be told is treated as one with nobody to tell,
     * which is what it is. Driven with an injected platform rather than left
     * to whichever machine runs the suite — a branch only its own platform can
     * exercise is a branch nobody checks.
     */
    expect(
      tellSupervisor(neverCalled, { BYOLLM_SUPERVISOR_PID: "1" }, "win32"),
    ).toBe("absent");
  });

  it("still signals on the platforms that have signals", () => {
    /* The control: the guard above must not be a guard against everything. */
    const sent: [number, string][] = [];
    for (const platform of ["linux", "darwin"]) {
      expect(
        tellSupervisor(
          (pid, signal) => sent.push([pid, signal]),
          { BYOLLM_SUPERVISOR_PID: "7" },
          platform,
        ),
        platform,
      ).toBe("told");
    }
    expect(sent).toEqual([
      [7, "SIGHUP"],
      [7, "SIGHUP"],
    ]);
  });
});

/** A `kill` that fails the test if anything reaches it. */
function neverCalled(): never {
  throw new Error("signalled when there was no supervisor to signal");
}

describe("how a daemon decides whether anybody is listening", () => {
  /**
   * B213 — the box crash-loop, and the reason no test caught it.
   *
   * `interactive` and `supervised` were default parameters computed from
   * `process.stdout.isTTY`, and **every existing case passed both explicitly**
   * — so the expressions that actually shipped were the one part nothing
   * drove. Under vitest `isTTY` is false, which is the opposite of a box, so
   * even a test that omitted them would have exercised the wrong side.
   */
  it("never asks a human when a supervisor started it, tty or not", () => {
    /**
     * The bug exactly. A Pod sets `tty: true` so a person can type at the
     * console, which makes `isTTY` true for every process in the container —
     * including the daemon, which has no human. It took the preflight path,
     * asked "Sign in now?", waited for an answer that could not come, drained
     * the event loop, exited 13, and was restarted into a crash loop.
     */
    expect(howItRuns({ BYOLLM_SUPERVISOR_PID: "1" }, true)).toEqual({
      supervised: true,
      interactive: false,
    });
  });

  it("knows it is supervised even though the tty says otherwise", () => {
    /* The second half of the same line: `supervised = !isTTY` was FALSE on a
       box, so the one daemon that certainly is supervised reported that it
       was not. */
    expect(howItRuns({ BYOLLM_SUPERVISOR_PID: "1" }, true).supervised).toBe(
      true,
    );
  });

  it("still reads the terminal when there is no supervisor", () => {
    /**
     * The control, and it is what keeps `byollm run` in somebody's own shell
     * working: with nobody supervising, a tty means a person is there and the
     * preflight sign-in offer is the whole point of the feature.
     */
    expect(howItRuns({}, true)).toEqual({
      supervised: false,
      interactive: true,
    });
    expect(howItRuns({}, false)).toEqual({
      supervised: true,
      interactive: false,
    });
  });

  it("ignores a supervisor pid it could not parse", () => {
    /* Same rule as signalling: a value we cannot read is no supervisor. A
       daemon that trusted `BYOLLM_SUPERVISOR_PID=banana` would stop asking on
       a laptop, which is a worse failure than the one being fixed. */
    expect(howItRuns({ BYOLLM_SUPERVISOR_PID: "banana" }, true)).toEqual({
      supervised: false,
      interactive: true,
    });
  });
});
