import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_YOUR_DEVICE } from "./test-your-device.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  refuseToSupervise,
  servicePlan,
  servicePlatform,
  SERVICE_LABEL,
  type ServicePlatform,
} from "./service.js";
import {
  installService,
  serviceState,
  uninstallService,
  type CommandRunner,
} from "./install.js";

/**
 * The service, on all three platforms, from whichever one you are on.
 *
 * The point of `servicePlan` being pure: a wrong plist is otherwise something
 * you discover by rebooting a Mac, and a wrong systemd unit is something
 * nobody on this project would discover at all. Here the exact file and the
 * exact commands are asserted everywhere the suite runs.
 */

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-service-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const target = (platform: ServicePlatform) => ({
  platform,
  execPath: "/usr/local/bin/node",
  scriptPath: "/usr/local/lib/node_modules/@byollm/daemon/dist/bin.js",
  home,
  root: join(home, ".byollm"),
});

/**
 * A supervisor that accepts everything and reports a live daemon.
 *
 * The default answers the liveness query — `state = running` for launchd,
 * `active` for systemd, `Running` for schtasks — because since 2026-09-03
 * `installService` asks it before claiming anything. A stub that answered ""
 * to every command was describing a machine where the unit loaded and the
 * daemon never started: the exact state the walk found, and not what these
 * cases are about. Tests that *are* about it say so, below.
 */
const LIVE = (command: readonly string[]): string =>
  command.includes("is-active")
    ? "active"
    : command.includes("/query")
      ? "TaskName Status\nbyollm  Running"
      : "state = running\n\tpid = 1234";

/** No real delay between probes; the poll itself is still exercised. */
const INSTANTLY = (): Promise<void> => Promise.resolve();

const recording = (
  outcome: (command: readonly string[]) => {
    code: number;
    output: string;
  } = (command) => ({
    code: 0,
    output: LIVE(command),
  }),
): { commands: string[][]; run: CommandRunner } => {
  const commands: string[][] = [];
  return {
    commands,
    run: (command) => {
      commands.push([...command]);
      return Promise.resolve(outcome(command));
    },
  };
};

describe("what gets written, per platform", () => {
  it("runs `byollm run` — not `connect`, which waits for a person", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const plan = servicePlan(target(platform));
      expect(plan.unitContents).toContain("run");
      // `connect` prints a pairing code and blocks until somebody types it
      // into a browser. A supervisor restarting *that* every ten seconds
      // would mint codes forever and serve nothing.
      expect(plan.unitContents).not.toMatch(/\bconnect\b/);
    }
  });

  it("keeps restarting after a clean exit, not only after a crash", () => {
    // A daemon that exits zero because no hub answered at boot has still
    // stopped serving. `SuccessfulExit: false` / `Restart=on-failure` would
    // leave that machine dark on its roster with nothing wrong in any log.
    const mac = servicePlan(target("darwin"));
    expect(mac.unitContents).toContain("<key>KeepAlive</key><true/>");
    expect(mac.unitContents).not.toContain("SuccessfulExit");

    const linux = servicePlan(target("linux"));
    expect(linux.unitContents).toContain("Restart=always");
    expect(linux.unitContents).not.toContain("Restart=on-failure");

    const win = servicePlan(target("win32"));
    expect(win.unitContents).toContain("<RestartOnFailure>");
  });

  it("installs into the user's own home, never a system location", () => {
    expect(servicePlan(target("darwin")).unitPath).toBe(
      join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    );
    expect(servicePlan(target("linux")).unitPath).toBe(
      join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`),
    );
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const plan = servicePlan(target(platform));
      // No root: the daemon runs as the person whose models these are, and an
      // uninstall they cannot perform without sudo is not their machine.
      expect(
        plan.unitPath.startsWith(home) ||
          plan.unitPath.startsWith(join(home, ".byollm")),
      ).toBe(true);
      expect(plan.activate.flat()).not.toContain("sudo");
      expect(plan.deactivate.flat()).not.toContain("sudo");
      expect(plan.unitContents).not.toContain("LaunchDaemons");
    }
  });

  it("escapes a home directory that contains XML, on both XML platforms", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const plan = servicePlan({
        ...target(platform),
        scriptPath: `/Users/a&b/<dist>/bin.js`,
      });
      expect(plan.unitContents).toContain("a&amp;b");
      expect(plan.unitContents).not.toContain("<dist>");
    }
  });

  it("points every platform's log at the same place the docs name", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(servicePlan(target(platform)).logPath).toBe(
        join(home, ".byollm", "service.log"),
      );
    }
  });
});

describe("refusing to supervise a copy that will vanish", () => {
  it("refuses an npx cache path, naming the one-line fix", () => {
    const refusal = refuseToSupervise(
      "/Users/todd/.npm/_npx/1a2b3c/node_modules/@byollm/daemon/dist/bin.js",
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("npm install -g byollm@alpha");
  });

  it("allows a global install", () => {
    expect(
      refuseToSupervise(
        "/usr/local/lib/node_modules/@byollm/daemon/dist/bin.js",
      ),
    ).toBeNull();
    expect(
      refuseToSupervise(
        "C:\\Users\\todd\\AppData\\Roaming\\npm\\node_modules\\@byollm\\daemon\\dist\\bin.js",
      ),
    ).toBeNull();
  });

  it("writes nothing when it refuses", async () => {
    const { commands, run } = recording();
    const result = await installService(
      { ...target("darwin"), scriptPath: "/Users/t/.npm/_npx/aa/bin.js" },
      run,
    );
    expect(result.ok).toBe(false);
    expect(commands).toEqual([]);
    await expect(readFile(result.plan.unitPath, "utf8")).rejects.toThrow();
  });
});

describe("installing", () => {
  it("writes the unit and activates it", async () => {
    const { commands, run } = recording();
    const result = await installService(target("linux"), run, INSTANTLY);

    expect(result.ok).toBe(true);
    expect(await readFile(result.plan.unitPath, "utf8")).toContain(
      "Restart=always",
    );
    /* The activation commands, which is what this case is about. The probe
       that follows them is `installService` confirming the daemon actually
       came up — asserted where that is the subject, not here. */
    expect(commands.slice(0, 2)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${SERVICE_LABEL}.service`],
    ]);
  });

  it("tolerates macOS's opening bootout, which fails when nothing is loaded", async () => {
    const { run } = recording((command) =>
      command[1] === "bootout"
        ? { code: 3, output: "No such process" }
        : { code: 0, output: LIVE(command) },
    );
    const result = await installService(target("darwin"), run, INSTANTLY);
    expect(result.ok).toBe(true);
  });

  /**
   * The walk's own transcript, as a test — ruled 2026-09-03.
   *
   * Setup printed "Installed. launchd will keep byollm running" and the TEST
   * pointer, directly above `byollm status` reporting "installed but NOT
   * running (last exit 2) — this device is on rosters and serving nothing".
   *
   * Both sentences were true, which is what located the bug: success meant
   * `launchctl bootstrap` exited zero. That is the job being *loaded*, never
   * the daemon being *alive* — found is not works, one layer down, on a
   * command that already had the better probe sitting in the same file.
   */
  it("refuses to call a dead daemon installed", async () => {
    const { run } = recording((command) =>
      // Activation succeeds; the daemon is loaded and keeps exiting. This is
      // launchd's own wording from the machine the walk ran on.
      command[1] === "print"
        ? { code: 0, output: "state = not running\n\tlast exit code = 2" }
        : { code: 0, output: "" },
    );
    const result = await installService(target("darwin"), run, INSTANTLY);

    expect(result.ok).toBe(false);
    const said = result.lines.join("\n");
    // The exit code, because it is the one fact that distinguishes a crash
    // loop from a slow start, and status had it all along.
    expect(said).toContain("last exit 2");
    // Where the run's own words are. Every other line is a guess without it.
    expect(said).toContain(".byollm");
    expect(said).toMatch(/byollm run/);
    // And it says what the silence costs, which is the part the walk felt.
    expect(said).toContain("rosters");
  });

  it("waits, rather than racing a daemon that is still starting", async () => {
    /* The control for the case above. A probe fired once, immediately after
       activation, would call every slow start a failure — the gate has to
       tell "not yet" from "never", and only a clock does that. */
    let asked = 0;
    const { run } = recording((command) => {
      if (command[1] !== "print") return { code: 0, output: "" };
      asked++;
      return asked < 3
        ? { code: 0, output: "state = not running" }
        : { code: 0, output: "state = running\n\tpid = 42" };
    });
    const result = await installService(target("darwin"), run, INSTANTLY);
    expect(result.ok).toBe(true);
    expect(asked).toBeGreaterThan(2);
  });

  it("is not fooled by a daemon that is alive for an instant", async () => {
    /**
     * A boot crash is running, briefly. launchd starts it, it throws, and
     * `ThrottleInterval` holds the restart for ten seconds — so a single
     * probe landing in that first instant reports a healthy install about a
     * process already on its way out.
     *
     * So the confirmation asks twice, and the second answer is the one that
     * counts.
     */
    let asked = 0;
    const { run } = recording((command) => {
      if (command[1] !== "print") return { code: 0, output: "" };
      asked++;
      return asked === 1
        ? { code: 0, output: "state = running\n\tpid = 42" }
        : { code: 0, output: "state = not running\n\tlast exit code = 2" };
    });
    const result = await installService(target("darwin"), run, INSTANTLY);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("last exit 2");
  });

  it("names a program that is no longer on disk", async () => {
    /**
     * The root cause behind the walk's exit 2, made legible.
     *
     * `install` records absolute paths to the node runtime that ran it. Under
     * a version manager those belong to one node version — install from a
     * shell on node 22, upgrade node, and the unit names a binary that is
     * gone. launchd cannot spawn it, so the daemon never runs, nothing ever
     * reaches the log, and every surface says only "last exit 2".
     *
     * The first version of this test used the shared `target()`, whose
     * `execPath` is `/usr/local/bin/node` — a path that happens not to exist
     * on my machine and happens to exist on CI's. It passed here and failed
     * there, which is a test asserting a fact about the machine it runs on.
     * Both paths are now inside the temp home, so the answer is ours to set.
     */
    const missing = {
      ...target("darwin"),
      execPath: join(home, "node-that-was-removed"),
    };
    const { run } = recording((command) =>
      command[1] === "print"
        ? { code: 0, output: "state = not running\n\tlast exit code = 2" }
        : { code: 0, output: "" },
    );
    const result = await installService(missing, run, INSTANTLY);

    expect(result.ok).toBe(false);
    const said = result.lines.join("\n");
    expect(said).toContain("no longer exists");
    expect(said).toContain("removed or upgraded");
  });

  it("does not blame the program when the program is there", async () => {
    /**
     * The control, and the reason the case above cannot be a bare grep.
     *
     * A failed install has several causes and only one of them is a missing
     * interpreter. Naming it every time would send somebody to reinstall node
     * over a crash in our own code — the same defect as "(last exit 2)",
     * pointed in a more confident direction.
     */
    const present = { ...target("darwin"), execPath: join(home, "node") };
    await writeFile(present.execPath, "#!/bin/sh\nexit 0\n", "utf8");

    const { run } = recording((command) =>
      command[1] === "print"
        ? { code: 0, output: "state = not running\n\tlast exit code = 2" }
        : { code: 0, output: "" },
    );
    const result = await installService(present, run, INSTANTLY);

    expect(result.ok).toBe(false);
    // Still refuses — the daemon is not running — but says nothing about the
    // binary, because there is nothing wrong with it.
    expect(result.lines.join("\n")).not.toContain("no longer exists");
  });

  it("reports a supervisor's refusal instead of claiming success", async () => {
    const { run } = recording((command) =>
      command.includes("bootstrap")
        ? { code: 5, output: "Load failed: 5: Input/output error" }
        : { code: 0, output: "" },
    );
    const result = await installService(target("darwin"), run, INSTANTLY);

    expect(result.ok).toBe(false);
    // The failing command and the supervisor's own words: an install that
    // half-worked leaves a machine looking installed and serving nothing.
    expect(result.lines.join("\n")).toContain("launchctl");
    expect(result.lines.join("\n")).toContain("Input/output error");
  });

  it("tells a Linux user about lingering, and does not do it for them", async () => {
    const { commands, run } = recording();
    const result = await installService(target("linux"), run, INSTANTLY);
    expect(result.lines.join("\n")).toContain("loginctl enable-linger");
    expect(commands.flat()).not.toContain("loginctl");
  });
});

describe("uninstalling", () => {
  it("removes the unit and says the owner's data stayed", async () => {
    const { run } = recording();
    await installService(target("darwin"), run, INSTANTLY);
    const result = await uninstallService(target("darwin"), run);

    await expect(readFile(result.plan.unitPath, "utf8")).rejects.toThrow();
    expect(result.lines.join("\n")).toContain("~/.byollm");
  });

  it("succeeds when there was nothing installed", async () => {
    const { run } = recording(() => ({ code: 1, output: "" }));
    const result = await uninstallService(target("linux"), run);
    // "It was not installed" and "it is now not installed" are one end state.
    // An uninstall that errors on a clean machine teaches people to ignore it.
    expect(result.ok).toBe(true);
  });
});

describe("asking whether it is actually running", () => {
  it("reads launchd's own word rather than the exit code", async () => {
    const loadedButStopped = recording(() => ({
      code: 0,
      output: `${SERVICE_LABEL} = {\n\tstate = not running\n\tlast exit code = 1\n}`,
    }));
    // The bug this exists to prevent: `launchctl print` exits zero for a job
    // that is loaded and dead, so an exit-code check reports a serving
    // machine that is serving nothing.
    expect(
      await serviceState(servicePlan(target("darwin")), loadedButStopped.run),
    ).toEqual({
      state: "installed",
      detail: "not running (last exit 1)",
    });

    const running = recording(() => ({
      code: 0,
      output: `${SERVICE_LABEL} = {\n\tstate = running\n\tpid = 4242\n}`,
    }));
    expect(
      await serviceState(servicePlan(target("darwin")), running.run),
    ).toEqual({
      state: "running",
    });
  });

  it("does not call systemd's `activating` running", async () => {
    const activating = recording(() => ({ code: 0, output: "activating\n" }));
    expect(
      await serviceState(servicePlan(target("linux")), activating.run),
    ).toEqual({
      state: "installed",
      detail: "activating",
    });
  });

  it("distinguishes a Windows task that is Ready from one that is Running", async () => {
    const ready = recording(() => ({
      code: 0,
      output: "TaskName Status\nbyollm Ready\n",
    }));
    expect(await serviceState(servicePlan(target("win32")), ready.run)).toEqual(
      {
        state: "installed",
        detail: "registered, not running",
      },
    );
  });

  it("calls a missing supervisor absent rather than throwing", async () => {
    const missing: CommandRunner = () => Promise.reject(new Error("ENOENT"));
    expect(await serviceState(servicePlan(target("linux")), missing)).toEqual({
      state: "absent",
    });
  });
});

describe("the CLI's own service commands", () => {
  it("says on `status` when nothing is supervising, and how to fix it", async () => {
    const { runCli } = await import("./cli.js");
    const { daemonPaths } = await import("./paths.js");
    let out = "";
    const code = await runCli(["status"], {
      paths: daemonPaths(home),
      io: { out: (text) => (out += text) },
      service: {
        platform: "linux",
        execPath: "/usr/bin/node",
        scriptPath: "/usr/lib/byollm/bin.js",
        run: () => Promise.resolve({ code: 4, output: "" }),
        home,
      },
    });

    expect(code).toBe(0);
    expect(out).toContain("service: not installed");
    expect(out).toContain("byollm install");
  });

  it("says loudly on `status` when installed but stopped", async () => {
    const { runCli } = await import("./cli.js");
    const { daemonPaths } = await import("./paths.js");
    let out = "";
    await runCli(["status"], {
      paths: daemonPaths(home),
      io: { out: (text) => (out += text) },
      service: {
        platform: "linux",
        execPath: "/usr/bin/node",
        scriptPath: "/usr/lib/byollm/bin.js",
        run: () => Promise.resolve({ code: 0, output: "failed\n" }),
        home,
      },
    });

    // The state that looks fine from a dashboard and serves nothing. It gets
    // the bluntest sentence in the command for that reason.
    expect(out).toContain("NOT running");
    expect(out).toContain("serving nothing");
  });

  it("exits non-zero when the install refuses, so a script can tell", async () => {
    const { runCli } = await import("./cli.js");
    const { daemonPaths } = await import("./paths.js");
    let err = "";
    // `out` as well as `err`: the first version of the assertion below watched
    // only stderr, and a mutant that printed the pointer unconditionally went
    // to stdout and passed. A check pointed at one stream says nothing about
    // the other.
    let out = "";
    const code = await runCli(["install"], {
      paths: daemonPaths(join(home, ".byollm")),
      io: { err: (text) => (err += text), out: (text) => (out += text) },
      service: {
        platform: "linux",
        execPath: "/usr/bin/node",
        scriptPath:
          "/home/t/.npm/_npx/ab12/node_modules/@byollm/daemon/dist/bin.js",
        run: () => Promise.resolve({ code: 0, output: "" }),
        wait: () => Promise.resolve(),
        home,
      },
    });

    expect(code).toBe(1);
    expect(err).toContain("npm install -g byollm@alpha");
    /**
     * And it does not tell them to go and test a device that is not running —
     * ruled 2026-09-02.
     *
     * This is the whole shape of the ruling in one assertion. The dashboard's
     * approved banner promised the device would start taking work, at a moment
     * when it might not be installed at all; the fix was to let the party that
     * watches the install succeed be the one that speaks. A pointer printed
     * here, on the refusal path, would move that same bug into the terminal.
     */
    expect(`${out}${err}`).not.toContain(TEST_YOUR_DEVICE);
  });

  it("installs and uninstalls through the CLI", async () => {
    const { runCli } = await import("./cli.js");
    const { daemonPaths } = await import("./paths.js");
    const commands: string[][] = [];
    const service = {
      platform: "linux" as const,
      execPath: "/usr/bin/node",
      scriptPath: "/usr/lib/byollm/bin.js",
      run: (command: readonly string[]) => {
        commands.push([...command]);
        // `is-active` is what install now asks before it claims anything —
        // ruled 2026-09-03. A stub that answered "" for every command was
        // describing a machine where the unit loaded and the daemon never
        // ran, which is the exact state the walk found and this gate exists
        // to catch, so it has to answer the liveness question on purpose.
        const active = command.includes("is-active");
        return Promise.resolve({ code: 0, output: active ? "active" : "" });
      },
      // Immediately, rather than the real half-second between probes.
      wait: () => Promise.resolve(),
      home,
    };
    const paths = daemonPaths(join(home, ".byollm"));

    let out = "";
    expect(
      await runCli(["install"], {
        paths,
        io: { out: (t) => (out += t) },
        service,
      }),
    ).toBe(0);
    expect(out).toContain("systemd");
    // Somebody who paired earlier and ran `byollm install` on its own has
    // reached the same moment as the end of `byollm setup`, and had nothing
    // telling them so.
    expect(out).toContain(TEST_YOUR_DEVICE);
    expect(
      await readFile(
        servicePlan({ ...service, root: paths.root }).unitPath,
        "utf8",
      ),
    ).toContain("ExecStart=/usr/bin/node /usr/lib/byollm/bin.js run");

    expect(
      await runCli(["uninstall"], {
        paths,
        io: { out: () => undefined },
        service,
      }),
    ).toBe(0);
    expect(commands.some((c) => c.includes("disable"))).toBe(true);
  });
});

describe("running the supervisor's commands for real", () => {
  it("collects output and the exit code of a command that works", async () => {
    const { spawnCommand } = await import("./install.js");
    const result = await spawnCommand([
      process.execPath,
      "-e",
      "console.log('hi')",
    ]);
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe("hi");
  });

  it("keeps what a failing command said on stderr, which is the reason", async () => {
    const { spawnCommand } = await import("./install.js");
    const result = await spawnCommand([
      process.execPath,
      "-e",
      "console.error('Load failed: 5'); process.exit(5)",
    ]);
    expect(result.code).toBe(5);
    expect(result.output).toContain("Load failed: 5");
  });

  it("reports a missing binary rather than throwing", async () => {
    const { spawnCommand } = await import("./install.js");
    // The real case: a container with no `systemctl` at all. This has to come
    // back as an ordinary answer, because `status` calls it on every run.
    const result = await spawnCommand(["byollm-no-such-binary-9f3a"]);
    expect(result.code).toBe(127);
  });
});

describe("choosing a supervisor from the platform", () => {
  it("maps the three Node reports, and treats the rest as systemd", () => {
    const cases: [string, string][] = [
      ["darwin", "darwin"],
      ["win32", "win32"],
      ["linux", "linux"],
      // Guessing loudly beats refusing to run: `install` will report whatever
      // the init system says rather than pretending this platform is absent.
      ["freebsd", "linux"],
    ];
    for (const [input, expected] of cases) {
      expect(servicePlatform(input)).toBe(expected);
    }
  });
});

describe("the states a supervisor reports, in its own words", () => {
  it("says loaded-but-never-run when launchd has no exit code yet", async () => {
    const loaded = recording(() => ({
      code: 0,
      output: `${SERVICE_LABEL} = {\n\tstate = not running\n}`,
    }));
    expect(
      await serviceState(servicePlan(target("darwin")), loaded.run),
    ).toEqual({
      state: "installed",
      detail: "loaded but not running",
    });
  });

  it("handles systemd answering with nothing at all", async () => {
    const silent = recording(() => ({ code: 0, output: "" }));
    expect(
      await serviceState(servicePlan(target("linux")), silent.run),
    ).toEqual({
      state: "installed",
      detail: "not running",
    });
  });

  it("reads a Windows task that is Running", async () => {
    const running = recording(() => ({
      code: 0,
      output:
        "TaskName  Next Run Time  Status\ncloud.byollm.daemon  N/A  Running\n",
    }));
    expect(
      await serviceState(servicePlan(target("win32")), running.run),
    ).toEqual({
      state: "running",
    });
  });

  it("reports a refusal that came with no explanation", async () => {
    const { run } = recording((command) =>
      command.includes("enable")
        ? { code: 1, output: "" }
        : { code: 0, output: "" },
    );
    const result = await installService(target("linux"), run, INSTANTLY);
    expect(result.ok).toBe(false);
    // No stray colon dangling where the supervisor said nothing.
    expect(result.lines.join("\n")).toContain("exit 1\n");
    expect(result.lines.join("\n")).toContain("still works in a terminal");
  });

  it("passes on what the supervisor said while removing, without failing", async () => {
    const { run } = recording(() => ({
      code: 1,
      output: "Failed to disable: unit not loaded",
    }));
    const result = await uninstallService(target("linux"), run);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("unit not loaded");
  });

  it("names launchd's domain with a real uid, not a shell variable", () => {
    const plan = servicePlan({ ...target("darwin"), uid: 501 });
    for (const command of [...plan.activate, ...plan.deactivate, plan.query]) {
      expect(command.join(" ")).not.toContain("$UID");
    }
    expect(plan.activate[1]?.[1]).toBe("bootstrap");
    expect(plan.activate[1]?.[2]).toBe("gui/501");

    // The bug this replaced: `gui/$UID` was left for a shell to expand, which
    // worked on macOS only because `/bin/sh` there sets `UID`. On CI's `dash`
    // it became the literal `gui/`, and a command that would have failed on a
    // real machine in a way that reads like a permissions problem.
    expect(plan.query.join(" ")).toContain("gui/501/cloud.byollm.daemon");
  });
});

describe("describing this process to a service file", () => {
  it("points at the node running now and this platform's supervisor", async () => {
    const { defaultServiceIo } = await import("./cli.js");
    const io = defaultServiceIo();
    // What ends up inside the plist. If this ever went relative, the service
    // would resolve it against the supervisor's working directory — which is
    // `/` — and fail at boot with "no such file".
    expect(io.execPath).toBe(process.execPath);
    expect(
      io.scriptPath.startsWith("/") || /^[A-Za-z]:\\/.test(io.scriptPath),
    ).toBe(true);
    expect(io.platform).toBe(servicePlatform(process.platform));
  });
});

describe("the service runs with a PATH that can find things", () => {
  /**
   * The gap this closes, found on a real machine.
   *
   * launchd gives an agent `/usr/bin:/bin:/usr/sbin:/sbin`. `claude` installs
   * to `~/.local/bin`, npm globals live under a Node version directory, and
   * Homebrew is `/opt/homebrew` — none of them on that list. So the daemon's
   * health probe for a subscription CLI failed, the service was never
   * advertised, and the device's page showed only the model server it could
   * reach. Nothing logged an error: "not installed" is a legal answer, and the
   * daemon cannot tell it from "installed somewhere I cannot see".
   *
   * `byollm services`, run in the user's shell, said the opposite.
   */
  const withPath = (path: string) => {
    const previous = process.env["PATH"];
    process.env["PATH"] = path;
    return () => {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    };
  };

  it("writes the installing shell's PATH into the launchd plist", () => {
    const restore = withPath("/Users/x/.local/bin:/opt/homebrew/bin");
    try {
      const plan = servicePlan(target("darwin"));
      expect(plan.unitContents).toContain("<key>EnvironmentVariables</key>");
      expect(plan.unitContents).toContain("/Users/x/.local/bin");
      expect(plan.unitContents).toContain("/opt/homebrew/bin");
    } finally {
      restore();
    }
  });

  it("writes it into the systemd unit too", () => {
    // A user unit does not inherit the login shell's environment either, so
    // fixing one platform and not the other would leave the same bug wearing
    // a different hat.
    const restore = withPath("/home/x/.local/bin");
    try {
      expect(servicePlan(target("linux")).unitContents).toContain(
        "Environment=PATH=/home/x/.local/bin",
      );
    } finally {
      restore();
    }
  });

  it("keeps the system directories, so a strange PATH still finds /bin", () => {
    const restore = withPath("/only/this");
    try {
      const contents = servicePlan(target("darwin")).unitContents;
      expect(contents).toContain("/only/this");
      expect(contents).toContain("/usr/bin");
      expect(contents).toContain("/sbin");
    } finally {
      restore();
    }
  });

  it("does not repeat a directory that is already there", () => {
    // Cosmetic, and the reason to bother is that this string is read by a
    // person diagnosing exactly the failure above.
    const restore = withPath("/usr/bin:/opt/homebrew/bin:/bin");
    try {
      const contents = servicePlan(target("darwin")).unitContents;
      const path =
        /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(contents)?.[1] ?? "";
      const dirs = path.split(":");
      expect(new Set(dirs).size).toBe(dirs.length);
    } finally {
      restore();
    }
  });
});

/**
 * A Windows machine that will not register a task still starts byollm.
 *
 * Registering a scheduled task is not always permitted — a managed laptop can
 * have it blocked by policy, a standard account can be refused elevation.
 * What that produced was an exit code and "the daemon is not supervised", on
 * the machine most likely to be somebody's work computer, which is the one
 * where "run it in a terminal forever" is least plausible.
 */
describe("windows, when the task will not register", () => {
  const denied = () => ({ code: 1, output: "ERROR: Access is denied." });

  it("falls back to the Startup folder and succeeds", async () => {
    const { run } = recording(denied);
    const result = await installService(target("win32"), run, INSTANTLY);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("Startup folder");
  });

  /* The weakness is stated, not implied. A supervisor that does not supervise
     must not be reported as one — somebody whose daemon dies at 2am should
     have been told at install time that nothing was going to restart it. */
  it("says what the fallback does not do", async () => {
    const { run } = recording(denied);
    const result = await installService(target("win32"), run, INSTANTLY);
    expect(result.lines.join("\n")).toContain("does not restart it");
  });

  /* "exit 1" is not something anybody can act on. Windows says "Access is
     denied" for the two cases that actually happen, and naming which turns a
     dead end into a sentence with a next step in it. */
  it("names the refusal rather than printing an exit code", () => {
    const { run } = recording(denied);
    return installService(target("win32"), run, INSTANTLY).then((result) => {
      const said = result.lines.join("\n");
      expect(said).toContain("will not let you register a scheduled task");
      expect(said).toContain("IT policy");
    });
  });

  /* A failure that is not about permission keeps its own words — guessing
     "no admin rights" at a disk error would send somebody to the wrong fix. */
  it("does not claim elevation when that was not the problem", async () => {
    const { run } = recording(() => ({
      code: 1,
      output: "ERROR: The system cannot find the file specified.",
    }));
    const result = await installService(target("win32"), run, INSTANTLY);
    expect(result.lines.join("\n")).not.toContain("administrator rights");
    expect(result.lines.join("\n")).toContain("cannot find the file");
  });
});
