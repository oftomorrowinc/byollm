import { describe, expect, it } from "vitest";
import { watchForUpdate } from "./cli.js";
import { DAEMON_VERSION } from "./index.js";

/**
 * A version that is always newer than the one running.
 *
 * Every fixture in this file needs "an offer above ours", and three of them
 * spelled it as a literal — which stops being true the day the product ships
 * that number. It did: `0.1.0-alpha.98` broke two of these tests on the .98
 * cut, for reasons unrelated to anything they assert.
 *
 * **The dynamic form broke too, at the 0.1.0 cut, and worse.** It was
 * `${DAEMON_VERSION}.1`, which is valid semver only while the version is a
 * prerelease: `0.1.0-alpha.103.1` parses, `0.1.0.1` does not. An offer that
 * does not parse is never newer, so `watchForUpdate` never took it and never
 * returned — `for (;;)` with nothing to end it. **The whole file hung rather
 * than failed**, which took a full CI run to see and read on a laptop as the
 * machine dying.
 *
 * So this bumps the numeric core and drops any prerelease, which is above
 * both shapes: `0.1.0-alpha.103` and `0.1.0` both yield `0.1.1`. A fixture
 * whose validity depends on the SHAPE of the version is a fixture that breaks
 * at a cut, which is the one moment nobody wants to be reading this file.
 */
function above(steps: number): string {
  const core = /^(\d+)\.(\d+)\.(\d+)/u.exec(DAEMON_VERSION);
  const major = core?.[1];
  const minor = core?.[2];
  const patch = core?.[3];
  if (major === undefined || minor === undefined || patch === undefined)
    throw new Error(`unparseable DAEMON_VERSION: ${DAEMON_VERSION}`);
  return `${major}.${minor}.${String(Number(patch) + steps)}`;
}

const NEWER_OFFER = above(1);
import type { Runner } from "./runner.js";

/**
 * What the daemon does with an offer — B053.
 *
 * The pieces are tested where they live: the ordering and rollback in
 * `update.test.ts`, the commands in `update-deps.test.ts`, the drain and the
 * event in `loop.test.ts`. This is the wiring, and every case here is about
 * a machine that should NOT end up stopped, updated, or drained by accident.
 */
function fakeRunner() {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      drain: (ms: number) => {
        calls.push(`drain:${String(ms)}`);
        return Promise.resolve();
      },
      resumeClaiming: () => {
        calls.push("resume");
      },
    } as unknown as Runner,
  };
}

const io = () => {
  const said: string[] = [];
  return {
    said,
    io: {
      out: () => undefined,
      err: (text: string) => said.push(text),
      confirm: () => Promise.resolve(false),
    },
  };
};

describe("taking an offered update", () => {
  it("drains, installs, and asks to be restarted", async () => {
    const r = fakeRunner();
    const surface = io();
    const ran: string[][] = [];
    const took = await watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: new AbortController().signal,
      offered: () => NEWER_OFFER,
      wait: () => Promise.resolve(),
      drainMs: 5,
      run: (command) => {
        ran.push([...command]);
        return Promise.resolve(
          command[1] === "--version"
            ? { code: 0, output: `byollm ${NEWER_OFFER} (protocol 1)\n` }
            : { code: 0, output: "" },
        );
      },
    });

    expect(took, "the caller exits only when the machine really moved").toBe(
      true,
    );
    expect(r.calls).toContain("drain:5");
    expect(ran[0]).toEqual([
      "npm",
      "install",
      "--global",
      `byollm@${NEWER_OFFER}`,
    ]);
    /* Drained before installed. The order is the safety, and asserting the
       calls happened says nothing about it. */
    expect(r.calls.indexOf("drain:5")).toBe(0);
  });

  it("goes back to work when the update did not take", async () => {
    /**
     * The case that matters most. A machine that rolled back and stayed
     * drained is a machine that is on the right version and quietly serving
     * nothing — worse than the state it started in, and invisible, because
     * every surface would say it is running.
     */
    const r = fakeRunner();
    const surface = io();
    const controller = new AbortController();
    const watching = watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: controller.signal,
      offered: () => NEWER_OFFER,
      wait: () => {
        if (r.calls.includes("resume")) controller.abort();
        return Promise.resolve();
      },
      drainMs: 5,
      run: (command) =>
        Promise.resolve(
          command[1] === "--version"
            ? { code: 0, output: `byollm ${DAEMON_VERSION} (protocol 1)\n` }
            : { code: 0, output: "" },
        ),
    });

    /* False, not true: the machine did not move, so the caller must not
       exit and hand the supervisor a restart that changes nothing. */
    expect(await watching).toBe(false);
    expect(r.calls).toContain("resume");
    expect(surface.said.join("")).toContain("rolled back");
  });

  it("takes a newer offer after one that failed", async () => {
    /**
     * CW's M-note on the first draft, and it was a daemon bug rather than a
     * hub one. The offer was recorded with `??=` and the watcher returned
     * after a failed update, so a machine that rolled back once never took
     * another update until somebody restarted it.
     *
     * Which means the fix for a bad release could not reach the machines the
     * bad release had landed on — the population that needs it most.
     */
    const r = fakeRunner();
    const surface = io();
    const installed: string[] = [];
    /**
     * Derived, not written down — this said `0.1.0-alpha.98` and broke on the
     * release that reached it.
     *
     * The fixture's whole job is to be NEWER than the running daemon, which a
     * literal stops being the moment the product catches up with it. That is a
     * test which passes for two hundred releases and then fails for a reason
     * that has nothing to do with what it tests, on the day somebody is
     * shipping. Two of them did exactly that here.
     */
    /* Through `above`, for the reason on NEWER_OFFER: these two spelled the
       same `${DAEMON_VERSION}.N` trick locally, and they are what actually
       hung the file at the cut. */
    const NEWER = above(1);
    const NEWER_STILL = above(2);
    let offering = NEWER;
    const took = await watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: new AbortController().signal,
      offered: () => offering,
      wait: () => {
        /* The second offer arrives the way a real one does: on a later
           heartbeat, after the first has been tried and failed. */
        offering = NEWER_STILL;
        return Promise.resolve();
      },
      drainMs: 5,
      run: (command) => {
        if (command[1] === "--version") {
          return Promise.resolve({
            code: 0,
            output: `byollm ${installed.at(-1) ?? DAEMON_VERSION} (protocol 1)\n`,
          });
        }
        if (command[1] === "install") {
          /* The first version installs as something else — a broken build —
             and the second installs cleanly. */
          const asked = command[3]?.replace("byollm@", "") ?? "";
          installed.push(asked === NEWER ? DAEMON_VERSION : asked);
        }
        return Promise.resolve({ code: 0, output: "" });
      },
    });

    expect(took).toBe(true);
    expect(surface.said.join("")).toContain("rolled back");
    expect(installed).toContain(NEWER_STILL);
  });

  it("does not retry a version it has already failed on", async () => {
    /* The other half. The offer keeps arriving until the machine takes it,
       so without a memory a failed update is a loop that reinstalls the same
       broken version every second. */
    const r = fakeRunner();
    const surface = io();
    const attempts: string[] = [];
    const controller = new AbortController();
    /* Counted in WAITS, not in attempts. Aborting after the first attempt
       would stop the loop before a forgetful watcher could make a second —
       which is exactly what the first version of this test did, and it
       passed with the memory deleted. */
    let cycles = 0;
    const watching = watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: controller.signal,
      offered: () => NEWER_OFFER,
      wait: () => {
        cycles += 1;
        if (cycles >= 5) controller.abort();
        return Promise.resolve();
      },
      drainMs: 5,
      run: (command) => {
        if (command[1] === "install") attempts.push(command[3] ?? "");
        return Promise.resolve(
          command[1] === "--version"
            ? { code: 0, output: `byollm ${DAEMON_VERSION} (protocol 1)\n` }
            : { code: 0, output: "" },
        );
      },
    });
    expect(await watching).toBe(false);
    expect(cycles).toBeGreaterThan(1);
    /* Once, across five cycles of the offer still arriving. */
    expect(attempts.filter((a) => a === `byollm@${NEWER_OFFER}`)).toHaveLength(
      1,
    );
  });

  it("never installs a tag, and never drains for one", async () => {
    /* The refusal happens before the drain, so a bad offer does not cost
       this machine the jobs it would have claimed. */
    const r = fakeRunner();
    const surface = io();
    const ran: string[][] = [];
    const controller = new AbortController();
    /* It keeps watching after a refusal — a bad offer is not a reason to
       stop serving, or to stop listening for a better one — so the test
       stops it rather than waiting for it to finish. */
    const refusing = watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: controller.signal,
      offered: () => "latest",
      wait: () => {
        if (surface.said.length > 0) controller.abort();
        return Promise.resolve();
      },
      run: (command) => {
        ran.push([...command]);
        return Promise.resolve({ code: 0, output: "" });
      },
    });
    expect(await refusing).toBe(false);
    expect(ran).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("drain"))).toEqual([]);
    expect(surface.said.join("")).toContain("exact versions only");
  });

  it("does nothing at all while nothing is offered", async () => {
    const r = fakeRunner();
    const ran: string[][] = [];
    const controller = new AbortController();
    const watching = watchForUpdate({
      runners: [r.runner],
      io: io().io,
      signal: controller.signal,
      offered: () => undefined,
      wait: () => Promise.resolve(),
      run: (command) => {
        ran.push([...command]);
        return Promise.resolve({ code: 0, output: "" });
      },
    });
    controller.abort();
    expect(await watching).toBe(false);
    expect(ran).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});
