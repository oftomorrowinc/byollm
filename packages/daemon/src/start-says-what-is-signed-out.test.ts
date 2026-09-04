import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { writeServiceStates } from "./service-states.js";
import { removeTemp } from "./test-support.js";

/**
 * `start` names a service that cannot sign in — B036.
 *
 * Kevin's daemon started cleanly on Windows and served nothing, because
 * `claude` was signed out. Everything was working: the task registered, the
 * process ran, `status` was honest — and the one screen he was watching said
 * the install had succeeded. He found out by noticing that no work arrived.
 *
 * The daemon writes what its start-up probe found. This reads it back at the
 * moment somebody is looking at the terminal, which is the only moment they
 * reliably are.
 *
 * Not a failure: the service is running and the rest of it works. So it is
 * said *alongside* the success rather than instead of it — the exit code and
 * the go-and-test-it line are unchanged.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

/** A supervisor that agrees to everything and reports the daemon running. */
const service = () => ({
  platform: "linux" as const,
  execPath: process.execPath,
  scriptPath: join(home, "byollm"),
  home,
  uid: 0,
  run: (command: readonly string[]) =>
    Promise.resolve({
      code: 0,
      output: command.includes("is-active") ? "active" : "",
    }),
  wait: () => Promise.resolve(),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-startsays-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
});

afterEach(async () => {
  await removeTemp(home);
});

describe("byollm start, when a backend is signed out", () => {
  it("says which, and how to fix it, without calling the start a failure", async () => {
    await writeServiceStates(
      paths.serviceStates,
      new Map([
        [
          "claude",
          {
            state: {
              kind: "signed-out" as const,
              detail: "the claude CLI is not signed in",
            },
            signIn: "run `claude` in a terminal",
          },
        ],
      ]),
    );

    const code = await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
    });

    expect(err).toContain("claude");
    expect(err).toContain("needs sign-in");
    expect(err, "the remedy the backend itself supplies").toContain(
      "run `claude` in a terminal",
    );
    /* The start worked. Reporting it as a failure would send somebody to
       re-run an install that has nothing wrong with it. */
    expect(code).toBe(0);
    expect(out).toContain("TEST YOUR DEVICE");
  });

  it("says nothing when nothing has been probed yet", async () => {
    /**
     * The control, and the rule it protects: **absent is not signed-out.** A
     * machine that has not probed has no problem to report, and inventing a
     * warning out of silence is the mistake the tri-state exists to prevent
     * — it would put "needs sign-in" on every first install in the product.
     */
    const code = await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
    });

    expect(err).not.toContain("needs sign-in");
    expect(code).toBe(0);
  });

  it("says nothing when the probe found it answering", async () => {
    await writeServiceStates(
      paths.serviceStates,
      new Map([
        ["claude", { state: { kind: "answers" as const, model: "m" } }],
      ]),
    );

    await runCli(["start"], { paths, io: io(), service: service() });
    /* Nothing at all, not merely no sign-in line. Without the filter this
       prints a row for every healthy service on every start — noise on the
       screen whose whole job is to say the one thing that is wrong, and an
       assertion that only looked for "needs sign-in" would not have noticed. */
    expect(err.trim()).toBe("");
  });
});
