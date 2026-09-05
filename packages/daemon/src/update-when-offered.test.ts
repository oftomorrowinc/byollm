import { describe, expect, it } from "vitest";
import { watchForUpdate } from "./cli.js";
import { DAEMON_VERSION } from "./index.js";
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

/** Resolves when `check` holds, so nothing here waits on a real timer. */
async function settles(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((wake) => setTimeout(wake, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("taking an offered update", () => {
  it("drains, installs, and asks to be restarted", async () => {
    const r = fakeRunner();
    const surface = io();
    const ran: string[][] = [];
    const took = await watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: new AbortController().signal,
      offered: () => "0.1.0-alpha.99",
      wait: () => Promise.resolve(),
      drainMs: 5,
      run: (command) => {
        ran.push([...command]);
        return Promise.resolve(
          command[1] === "--version"
            ? { code: 0, output: "byollm 0.1.0-alpha.99 (protocol 1)\n" }
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
      "byollm@0.1.0-alpha.99",
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
    const never = watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: new AbortController().signal,
      offered: () => "0.1.0-alpha.99",
      wait: () => Promise.resolve(),
      drainMs: 5,
      run: (command) =>
        Promise.resolve(
          command[1] === "--version"
            ? { code: 0, output: `byollm ${DAEMON_VERSION} (protocol 1)\n` }
            : { code: 0, output: "" },
        ),
    });

    await settles(() => r.calls.includes("resume"), "claiming to resume");
    expect(surface.said.join("")).toContain("rolled back");
    /* And it does not resolve: a rollback is not a reason to stop serving. */
    const raced = await Promise.race([
      never,
      new Promise<"still-serving">((wake) => {
        setTimeout(() => {
          wake("still-serving");
        }, 30);
      }),
    ]);
    expect(raced).toBe("still-serving");
  });

  it("never installs a tag, and never drains for one", async () => {
    /* The refusal happens before the drain, so a bad offer does not cost
       this machine the jobs it would have claimed. */
    const r = fakeRunner();
    const surface = io();
    const ran: string[][] = [];
    /* Never resolves — a refusal is not a reason to stop serving — so it is
       deliberately not awaited, and the assertions below are what this test
       is watching for. */
    const refusing = watchForUpdate({
      runners: [r.runner],
      io: surface.io,
      signal: new AbortController().signal,
      offered: () => "latest",
      wait: () => Promise.resolve(),
      run: (command) => {
        ran.push([...command]);
        return Promise.resolve({ code: 0, output: "" });
      },
    });
    await settles(() => surface.said.length > 0, "the refusal to be reported");
    expect(ran).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("drain"))).toEqual([]);
    expect(surface.said.join("")).toContain("exact versions only");
    /* Never resolves, and that is the behaviour — attached so the linter
       sees a handled promise rather than a dropped one. */
    refusing.catch(() => undefined);
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
