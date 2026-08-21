import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const recording = (
  outcome: (command: readonly string[]) => {
    code: number;
    output: string;
  } = () => ({
    code: 0,
    output: "",
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
    const result = await installService(target("linux"), run);

    expect(result.ok).toBe(true);
    expect(await readFile(result.plan.unitPath, "utf8")).toContain(
      "Restart=always",
    );
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${SERVICE_LABEL}.service`],
    ]);
  });

  it("tolerates macOS's opening bootout, which fails when nothing is loaded", async () => {
    const { run } = recording((command) =>
      command[1] === "bootout"
        ? { code: 3, output: "No such process" }
        : { code: 0, output: "" },
    );
    const result = await installService(target("darwin"), run);
    expect(result.ok).toBe(true);
  });

  it("reports a supervisor's refusal instead of claiming success", async () => {
    const { run } = recording((command) =>
      command.includes("bootstrap")
        ? { code: 5, output: "Load failed: 5: Input/output error" }
        : { code: 0, output: "" },
    );
    const result = await installService(target("darwin"), run);

    expect(result.ok).toBe(false);
    // The failing command and the supervisor's own words: an install that
    // half-worked leaves a machine looking installed and serving nothing.
    expect(result.lines.join("\n")).toContain("launchctl");
    expect(result.lines.join("\n")).toContain("Input/output error");
  });

  it("tells a Linux user about lingering, and does not do it for them", async () => {
    const { commands, run } = recording();
    const result = await installService(target("linux"), run);
    expect(result.lines.join("\n")).toContain("loginctl enable-linger");
    expect(commands.flat()).not.toContain("loginctl");
  });
});

describe("uninstalling", () => {
  it("removes the unit and says the owner's data stayed", async () => {
    const { run } = recording();
    await installService(target("darwin"), run);
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
    const code = await runCli(["install"], {
      paths: daemonPaths(join(home, ".byollm")),
      io: { err: (text) => (err += text) },
      service: {
        platform: "linux",
        execPath: "/usr/bin/node",
        scriptPath:
          "/home/t/.npm/_npx/ab12/node_modules/@byollm/daemon/dist/bin.js",
        run: () => Promise.resolve({ code: 0, output: "" }),
        home,
      },
    });

    expect(code).toBe(1);
    expect(err).toContain("npm install -g byollm@alpha");
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
        return Promise.resolve({ code: 0, output: "" });
      },
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
    const result = await installService(target("linux"), run);
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

  it("runs launchd's domain target through a shell, since it contains $UID", async () => {
    const { spawnCommand } = await import("./install.js");
    // The plan's macOS commands use `gui/$UID`, which only means anything
    // after a shell expands it. Sending that as a literal argv would target a
    // domain named `gui/$UID` and fail in a way that reads like a permissions
    // problem.
    const result = await spawnCommand(["echo", "gui/$UID"]);
    expect(result.code).toBe(0);
    expect(result.output.trim()).not.toBe("gui/$UID");
    expect(result.output.trim()).toMatch(/^gui\/\d+$/);
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
