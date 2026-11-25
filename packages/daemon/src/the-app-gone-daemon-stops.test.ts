import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_LOOK_AGAIN_MS, type After } from "./app-note.js";
import { runCli, type CliIo, type ServiceIo } from "./cli.js";
import { writeHealth } from "./health.js";
import type { CommandRunner } from "./install.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { servicePlan } from "./service.js";
import { pairedForStart, removeTemp } from "./test-support.js";

/**
 * A daemon the BYOLLM app installed stops itself when the app is gone —
 * #11051, ruled on #10663: "The daemon removes its start-at-login entry
 * before it stops itself."
 *
 * The real `byollm run`, with the supervisor's commands as the double and
 * the clock in the test's hand. The unit file, the note and the app are real
 * files, so "the plist is gone before the bootout" is read off the disk at
 * the moment the bootout is asked for — not off a list a fake kept.
 *
 * What this cannot show is what launchd and Task Scheduler then do. That is
 * by hand, on a Mac and on Windows; see the README's "When the BYOLLM app is
 * removed".
 */

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

let home: string;
let paths: DaemonPaths;
let err: string;
let node: string;
let program: string;
let app: string;

const io = (): Partial<CliIo> => ({
  out: () => undefined,
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; the log said:\n${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function handClock(): {
  after: After;
  timers: { ms: number; fire: () => void }[];
} {
  const timers: { ms: number; fire: () => void }[] = [];
  return {
    timers,
    after: (ms, fn) => {
      timers.push({ ms, fire: fn });
      return () => undefined;
    },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-app-gone-"));
  paths = daemonPaths(join(home, ".byollm"));
  err = "";
  node = join(paths.root, "node", "bin", "node");
  program = join(paths.root, "node", "lib", "node_modules", "byollm", "bin.js");
  app = join(home, "Applications", "BYOLLM.app");
  await mkdir(join(paths.root, "node", "bin"), { recursive: true });
  await mkdir(join(paths.root, "node", "lib", "node_modules", "byollm"), {
    recursive: true,
  });
  await mkdir(app, { recursive: true });
  await writeFile(node, "");
  await writeFile(program, "");
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        local: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    }),
  );
  await writeFile(
    paths.appNote,
    JSON.stringify({ format: 1, app, node, program }),
  );
});

afterEach(async () => {
  await removeTemp(home);
});

/** A device revoked by its hub: the daemon parks under a supervisor. */
async function parked(): Promise<void> {
  await writeHealth(paths.health, {
    at: 1_800_000_000_000,
    consecutiveFailures: 0,
    origin: "http://127.0.0.1:1",
    revoked: { at: 1_800_000_000_000, origin: "http://127.0.0.1:1" },
  });
}

function service(
  platform: "darwin" | "win32" | "linux",
  run: CommandRunner,
  self: { execPath: string; scriptPath: string } = {
    execPath: node,
    scriptPath: program,
  },
): ServiceIo {
  return {
    platform,
    ...self,
    run,
    home,
    uid: 501,
    appData: join(home, "AppData", "Roaming"),
  };
}

describe("on a Mac", () => {
  it("deletes the plist, records why, and only then boots the job out", async () => {
    const plan = servicePlan({
      platform: "darwin",
      execPath: node,
      scriptPath: program,
      home,
      uid: 501,
      root: paths.root,
    });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plan.unitPath, plan.unitContents);
    await parked();

    const asked: {
      command: string;
      plistThere: boolean;
      markThere: boolean;
    }[] = [];
    const run: CommandRunner = async (command) => {
      asked.push({
        command: command.join(" "),
        plistThere: await exists(plan.unitPath),
        markThere: await exists(paths.appRemoved),
      });
      return { code: 0, output: "" };
    };
    const clock = handClock();
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: service("darwin", run),
      supervised: true,
      parkPollMs: 25,
      after: clock.after,
    });
    await until(() => err.includes("revoked"), "the daemon to park");

    /* The app is gone at start; nothing happens until the minute has passed. */
    await rm(app, { recursive: true });
    await until(() => clock.timers.length >= 1, "the daily timer");
    clock.timers.at(-1)?.fire();
    await until(
      () => clock.timers.some((t) => t.ms === APP_LOOK_AGAIN_MS),
      "the look a minute later",
    );
    expect(await exists(plan.unitPath)).toBe(true);
    expect(asked).toEqual([]);

    clock.timers.at(-1)?.fire();
    expect(await done).toBe(0);

    /* One command, and it is the bootout by label: the plist it would be
       named by has gone, and the mark was on disk before it was asked for. */
    expect(asked).toEqual([
      {
        command: "launchctl bootout gui/501/cloud.byollm.daemon",
        plistThere: false,
        markThere: true,
      },
    ]);
    expect(err).toContain(
      "removing this daemon's start-at-login entry, then stopping",
    );
    expect(err).toContain("stopping because the BYOLLM app was removed");
    /* Nothing but the entry. */
    for (const kept of [
      paths.config,
      paths.appNote,
      paths.health,
      node,
      program,
    ]) {
      expect(await exists(kept)).toBe(true);
    }
  }, 30_000);

  it("checks at start too, beside a serving daemon", async () => {
    const plan = servicePlan({
      platform: "darwin",
      execPath: node,
      scriptPath: program,
      home,
      uid: 501,
      root: paths.root,
    });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plan.unitPath, plan.unitContents);
    /* Paired, so this is `runLoop`, not the park. The hub is unreachable and
       the daemon keeps retrying it; the app check is what ends it. */
    await pairedForStart(paths.pairings, "http://127.0.0.1:1");
    await rm(app, { recursive: true });

    const asked: { command: string; plistThere: boolean }[] = [];
    const run: CommandRunner = async (command) => {
      asked.push({
        command: command.join(" "),
        plistThere: await exists(plan.unitPath),
      });
      return { code: 0, output: "" };
    };
    const clock = handClock();
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: service("darwin", run),
      supervised: true,
      interactive: false,
      after: clock.after,
    });
    await until(
      () => clock.timers.some((t) => t.ms === APP_LOOK_AGAIN_MS),
      "the look a minute later",
    );
    expect(asked).toEqual([]);
    clock.timers.at(-1)?.fire();
    expect(await done).toBe(0);
    expect(asked).toEqual([
      {
        command: "launchctl bootout gui/501/cloud.byollm.daemon",
        plistThere: false,
      },
    ]);
  }, 30_000);

  it("`byollm status` afterwards says the app was removed, not NOT RUNNING", async () => {
    await parked();
    const clock = handClock();
    await rm(app, { recursive: true });
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: service("darwin", () =>
        Promise.resolve({ code: 0, output: "" }),
      ),
      supervised: true,
      parkPollMs: 25,
      after: clock.after,
    });
    await until(
      () => clock.timers.some((t) => t.ms === APP_LOOK_AGAIN_MS),
      "the look a minute later",
    );
    clock.timers.at(-1)?.fire();
    expect(await done).toBe(0);

    let out = "";
    /* launchd no longer knows the job: `print` exits 113. */
    await runCli(["status"], {
      paths,
      io: {
        ...io(),
        out: (text) => {
          out += text;
        },
      },
      service: service("darwin", () =>
        Promise.resolve({ code: 113, output: "" }),
      ),
    });
    expect(out).toContain("state: STOPPED — the BYOLLM app was removed");
    expect(out).toContain(`the BYOLLM app is no longer at ${app}`);
    expect(out).toContain("removed its start-at-login entry and stopped");
    expect(out).toContain(
      "service: not installed — the daemon removed its own",
    );
    expect(out).not.toContain("NOT RUNNING");
    expect(out).not.toContain("REVOKED");

    let json = "";
    await runCli(["status", "--json"], {
      paths,
      io: {
        ...io(),
        out: (text) => {
          json += text;
        },
      },
      service: service("darwin", () =>
        Promise.resolve({ code: 113, output: "" }),
      ),
    });
    expect((JSON.parse(json) as { state: string }).state).toBe("stopped");

    /* The next daemon to start clears it: a running daemon is not stopped. */
    await runCli(["run"], {
      paths,
      io: io(),
      service: service("darwin", () =>
        Promise.resolve({ code: 0, output: "" }),
      ),
      signal: AbortSignal.abort(),
      after: handClock().after,
    });
    expect(await exists(paths.appRemoved)).toBe(false);
  }, 30_000);
});

describe("on Windows", () => {
  it("deletes the task and the Startup entry, ends nothing, and returns", async () => {
    const plan = servicePlan({
      platform: "win32",
      execPath: node,
      scriptPath: program,
      home,
      root: paths.root,
      appData: join(home, "AppData", "Roaming"),
    });
    const startup = plan.fallback?.unitPath ?? "";
    await writeFile(plan.unitPath, plan.unitContents);
    await mkdir(join(startup, ".."), { recursive: true });
    await writeFile(startup, "@echo off\r\n");
    await parked();

    let registered = true;
    const asked: string[] = [];
    const run: CommandRunner = (command) => {
      const said = command.join(" ");
      asked.push(said);
      if (said === "schtasks /delete /tn cloud.byollm.daemon /f") {
        registered = false;
        return Promise.resolve({ code: 0, output: "" });
      }
      if (said === "schtasks /query /tn cloud.byollm.daemon") {
        return Promise.resolve(
          registered ? { code: 0, output: "Running" } : { code: 1, output: "" },
        );
      }
      return Promise.resolve({ code: 0, output: "" });
    };
    const clock = handClock();
    await rm(app, { recursive: true });
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: service("win32", run),
      supervised: true,
      parkPollMs: 25,
      after: clock.after,
    });
    await until(
      () => clock.timers.some((t) => t.ms === APP_LOOK_AGAIN_MS),
      "the look a minute later",
    );
    clock.timers.at(-1)?.fire();
    expect(await done).toBe(0);

    /* No `/end` and no `taskkill`: those end this process, and nothing may
       before the task is gone. The daemon's own return is the stop. */
    expect(asked).toEqual([
      "schtasks /delete /tn cloud.byollm.daemon /f",
      "schtasks /query /tn cloud.byollm.daemon",
    ]);
    expect(await exists(plan.unitPath)).toBe(false);
    expect(await exists(startup)).toBe(false);
    expect(await exists(paths.appRemoved)).toBe(true);
  }, 30_000);

  it("keeps serving when Task Scheduler still has the task", async () => {
    await parked();
    const asked: string[] = [];
    const run: CommandRunner = (command) => {
      asked.push(command.join(" "));
      return Promise.resolve(
        command[1] === "/delete"
          ? { code: 1, output: "ERROR: Access is denied." }
          : { code: 0, output: "Ready" },
      );
    };
    const clock = handClock();
    await rm(app, { recursive: true });
    const stop = new AbortController();
    const done = runCli(["run"], {
      paths,
      io: io(),
      service: service("win32", run),
      supervised: true,
      parkPollMs: 25,
      signal: stop.signal,
      after: clock.after,
    });
    await until(
      () => clock.timers.some((t) => t.ms === APP_LOOK_AGAIN_MS),
      "the look a minute later",
    );
    clock.timers.at(-1)?.fire();
    await until(() => err.includes("keeps running"), "the refusal to stop");
    expect(err).toContain("Access is denied");
    expect(await exists(paths.appRemoved)).toBe(false);
    stop.abort();
    expect(await done).toBe(0);
  }, 30_000);
});

describe("a daemon the note is not about", () => {
  it("an npm daemon on a machine that also has the app never stops itself", async () => {
    const npmNode = join(home, "usr", "bin", "node");
    const npmProgram = join(
      home,
      "usr",
      "lib",
      "node_modules",
      "byollm",
      "bin.js",
    );
    await mkdir(join(home, "usr", "bin"), { recursive: true });
    await mkdir(join(home, "usr", "lib", "node_modules", "byollm"), {
      recursive: true,
    });
    await writeFile(npmNode, "");
    await writeFile(npmProgram, "");
    const plan = servicePlan({
      platform: "darwin",
      execPath: npmNode,
      scriptPath: npmProgram,
      home,
      uid: 501,
      root: paths.root,
    });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plan.unitPath, plan.unitContents);
    await rm(app, { recursive: true });

    const asked: string[] = [];
    const clock = handClock();
    await runCli(["run"], {
      paths,
      io: io(),
      service: service(
        "darwin",
        (command) => {
          asked.push(command.join(" "));
          return Promise.resolve({ code: 0, output: "" });
        },
        { execPath: npmNode, scriptPath: npmProgram },
      ),
      supervised: false,
      after: clock.after,
    });
    expect(clock.timers).toEqual([]);
    expect(asked).toEqual([]);
    expect(await exists(plan.unitPath)).toBe(true);
    expect(err).toContain("this daemon ignores it");
  }, 30_000);

  it("a Linux daemon named by the note sets no timer", async () => {
    await rm(app, { recursive: true });
    const clock = handClock();
    const asked: string[] = [];
    await runCli(["run"], {
      paths,
      io: io(),
      service: service("linux", (command) => {
        asked.push(command.join(" "));
        return Promise.resolve({ code: 0, output: "" });
      }),
      supervised: false,
      after: clock.after,
    });
    expect(clock.timers).toEqual([]);
    expect(asked).toEqual([]);
    expect(err).not.toContain("app note");
  }, 30_000);
});
