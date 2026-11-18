import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { runCli as RunCli } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { servicePlan, type ServicePlatform } from "./service.js";
import { pairedForStart, removeTemp } from "./test-support.js";

/**
 * `byollm start` installs nothing on a machine with nothing to serve — #9703.
 *
 * Kevin, klab, 11-18 (systemd user session, build bcc363c):
 *
 * 1. never set up — the unit logged to `~/.byollm/service.log` in a directory
 *    that did not exist, and systemd failed it with 209/STDOUT every 10 s;
 * 2. set up, not paired — `run` exits 2 at once and `Restart=always` started
 *    it again every 10 s.
 *
 * launchd (`KeepAlive`, 10 s throttle) loops the same way; Task Scheduler
 * registers a task whose daemon exits at once and stays down until the next
 * logon. So the gate is in `start`, before anything platform-specific, and
 * every case below runs on all three.
 *
 * "Did not touch the supervisor" is checked two ways, because either alone
 * has a hole: no command reached the double, AND no unit file was written —
 * the write happens before the first command and is the half systemd then
 * finds on its own at the next `daemon-reload`.
 */
const PLATFORMS: readonly ServicePlatform[] = ["linux", "darwin", "win32"];

let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;
let ran: string[][];

let runCli: typeof RunCli;
beforeAll(async () => {
  ({ runCli } = await import("./cli.js"));
}, 30_000);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-9703-"));
  paths = daemonPaths(join(home, ".byollm"));
  out = "";
  err = "";
  ran = [];
});
afterEach(() => removeTemp(home));

/** A supervisor that agrees to everything and reports the daemon running. */
function service(platform: ServicePlatform) {
  return {
    platform,
    execPath: "/usr/bin/node",
    scriptPath: "/usr/lib/byollm/bin.js",
    home,
    uid: 501,
    appData: join(home, "AppData"),
    run: (command: readonly string[]) => {
      ran.push([...command]);
      return Promise.resolve({
        code: 0,
        output: command.includes("is-active")
          ? "active"
          : command[1] === "print"
            ? "state = running\n"
            : command[1] === "/query"
              ? "Running\n"
              : "",
      });
    },
    wait: () => Promise.resolve(),
  };
}

function start(platform: ServicePlatform): Promise<number> {
  return runCli(["start"], {
    paths,
    io: {
      out: (t) => (out += t),
      err: (t) => (err += t),
      confirm: () => Promise.resolve(false),
    },
    service: service(platform),
    interactive: false,
    verify: () => Promise.resolve({ answers: true }),
  });
}

function unitPath(platform: ServicePlatform): string {
  return servicePlan({ ...service(platform), root: paths.root }).unitPath;
}

function fallbackPath(platform: ServicePlatform): string | undefined {
  return servicePlan({ ...service(platform), root: paths.root }).fallback
    ?.unitPath;
}

describe.each(PLATFORMS)("byollm start on %s", (platform) => {
  it("on a machine never set up: names `byollm setup`, exits 1, touches nothing", async () => {
    const code = await start(platform);

    expect(code).toBe(1);
    expect(err).toContain("has not been set up");
    expect(err).toContain("byollm setup");
    expect(err).toContain("Nothing was installed.");
    expect(ran).toEqual([]);
    expect(existsSync(unitPath(platform))).toBe(false);
    const fallback = fallbackPath(platform);
    if (fallback !== undefined) expect(existsSync(fallback)).toBe(false);
    /* Not even the state directory: on Windows the unit lives in it, and
       `installService` was what created it. */
    expect(existsSync(paths.root)).toBe(false);
    expect(out).not.toContain("TEST YOUR DEVICE");
  });

  it("set up but not paired: names pairing, not setup, exits 1, touches nothing", async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.config, JSON.stringify({ services: {} }));

    const code = await start(platform);

    expect(code).toBe(1);
    expect(err).toContain("not paired");
    expect(err).toContain("byollm connect");
    expect(err).not.toContain("byollm setup");
    expect(ran).toEqual([]);
    expect(existsSync(unitPath(platform))).toBe(false);
  });

  it("with a pairings file it cannot read: says so, and still installs nothing", async () => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.pairings, "{ not json");

    expect(await start(platform)).toBe(1);
    expect(err).toContain("could not read the pairing");
    expect(err).toContain("Nothing was installed.");
    expect(ran).toEqual([]);
  });

  it("leaves a service installed earlier exactly as it was", async () => {
    /* Refusing to add a broken service is not a licence to remove a working
       one; `byollm stop` is the command for that. */
    const unit = unitPath(platform);
    await mkdir(join(unit, ".."), { recursive: true });
    await writeFile(unit, "installed earlier");

    expect(await start(platform)).toBe(1);
    expect(ran).toEqual([]);
    expect(await readFile(unit, "utf8")).toBe("installed earlier");
  });

  it("once paired, installs as before — the control", async () => {
    /* Without this the cases above would pass on a `start` that refused
       everything. */
    await pairedForStart(paths.pairings);

    expect(await start(platform)).toBe(0);
    expect(ran.length).toBeGreaterThan(0);
    expect(existsSync(unitPath(platform))).toBe(true);
    expect(err).not.toContain("Nothing was installed.");
  });
});
