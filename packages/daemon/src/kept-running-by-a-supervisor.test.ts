import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, servingLine, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import {
  readKeptRunningBy,
  supervisorName,
  writeKeptRunningBy,
} from "./supervised.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * `byollm run --supervised <name>` — decision #8404 part 4, the daemon half.
 *
 * Todd on box-1's console, 11-12. PID 1 there is the box's supervisor and it
 * runs `byollm run` as a child; there is no systemd. `status` said "service:
 * not installed — jobs only run while `byollm run` is open (`byollm start`
 * fixes that)", which was false, and `stop` removed a unit that did nothing,
 * after which `start` failed on `systemctl --user daemon-reload — exit 127`.
 *
 * Every case that says "changes no unit" proves it the only way that counts:
 * the service seam records each command, and the record must stay empty.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;
/** Every command the service seam was asked to run. */
let ran: (readonly string[])[];

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

/** No supervisor on this machine, and a witness to anything asked of one. */
const service = () => ({
  ...noSupervisor(),
  /* The unit file is written under here, never under the real home. */
  home,
  run: (command: readonly string[]) => {
    ran.push(command);
    return Promise.resolve({ code: 127, output: "" });
  },
  wait: () => Promise.resolve(),
});

const cli = (argv: string[]) =>
  runCli(argv, {
    paths,
    io: io(),
    service: service(),
    /* `run` asks its backends before serving; nothing here is about that,
       and a test must not spend a canary or open a sign-in. */
    interactive: false,
    verify: () => Promise.resolve({ answers: true }),
  });

/** A pid that certainly named a process and certainly does not any more. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  if (pid === undefined) throw new Error("the child never started");
  return pid;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-8404-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
  ran = [];
});
afterEach(() => removeTemp(home));

describe("byollm run --supervised <name>", () => {
  it("records who keeps it running, with the run's pid", async () => {
    /* Nothing is paired, so the run ends at once with its usual refusal —
       and the record was written before that, because a supervised daemon
       that exits on its first tick is restarted by its supervisor and is
       still supervised in the meantime. */
    expect(await cli(["run", "--supervised", "box"])).toBe(2);
    expect(err).toContain("No app is paired");
    const record = await readKeptRunningBy(paths.supervisor);
    expect(record?.by).toBe("box");
    expect(record?.pid).toBe(process.pid);
  });

  it("makes status say so, and say nothing about start", async () => {
    await cli(["run", "--supervised", "box"]);
    out = "";
    ran = [];
    expect(await cli(["status"])).toBe(0);
    expect(out).toContain("service: kept running by box\n");
    expect(out).not.toContain("not installed");
    expect(out).not.toContain("byollm start");
    /* And it never asked systemd: on a box there is none to ask. */
    expect(ran).toEqual([]);
  });

  it("makes start and stop say so, exit 0, and change no unit", async () => {
    await cli(["run", "--supervised", "box"]);
    for (const verb of ["start", "stop"]) {
      out = "";
      err = "";
      expect(await cli([verb])).toBe(0);
      expect(out).toBe(
        "this device is kept running by box; nothing to install or remove\n",
      );
      expect(err).toBe("");
    }
    expect(ran).toEqual([]);
  });

  it("refuses a name with nothing printable in it", async () => {
    /* A name reaches every `status`; an escape sequence in it is a repaint
       of somebody's terminal, and an empty one is a line that says nothing. */
    expect(await cli(["run", "--supervised", "\u001b\u0007 "])).toBe(2);
    expect(err).toContain("needs the name");
    expect(existsSync(paths.supervisor)).toBe(false);
    expect(supervisorName("this\u0007 box")).toBe("this box");
    expect(supervisorName("\u001b[2Jbox")).toBe("[2Jbox");
  });

  it("refuses the flag without a name rather than taking it as one", async () => {
    expect(await cli(["run", "--supervised"])).toBe(2);
    expect(err).toContain("byollm run --supervised <name>");
    expect(existsSync(paths.supervisor)).toBe(false);
  });
});

describe("without the flag, nothing changes", () => {
  it("status keeps the old line", async () => {
    expect(await cli(["status"])).toBe(0);
    expect(out).toContain(
      "service: not installed — jobs only run while `byollm run` is open " +
        "(`byollm start` fixes that)\n",
    );
    expect(out).not.toContain("kept running by");
  });

  it("start and stop still go to the service manager", async () => {
    await cli(["start"]);
    expect(ran.length).toBeGreaterThan(0);
    ran = [];
    await cli(["stop"]);
    expect(ran.length).toBeGreaterThan(0);
    expect(out).not.toContain("kept running by");
  });

  it("a plain run forgets a supervisor whose run is gone", async () => {
    /* A laptop that once ran under a supervisor and now runs in a terminal
       must not keep saying it is supervised. */
    await writeKeptRunningBy(paths.supervisor, {
      by: "box",
      pid: await deadPid(),
      at: Date.now(),
    });
    await cli(["run"]);
    expect(existsSync(paths.supervisor)).toBe(false);
  });

  it("a plain run leaves a supervisor whose run is alive", async () => {
    /* The control: somebody typing `byollm run` at a box's console while
       the supervised daemon serves must not erase the supervisor's claim and
       send the next `start` back to a systemd that is not there. */
    await writeKeptRunningBy(paths.supervisor, {
      by: "box",
      pid: process.pid,
      at: Date.now(),
    });
    await cli(["run"]);
    expect(await readFile(paths.supervisor, "utf8")).toContain('"box"');
  });
});

describe("the startup line", () => {
  it("names the supervisor under the flag, and Ctrl-C without it", () => {
    const supervised = servingLine("box-1", "1 site", "box");
    expect(supervised).toContain("Kept running by box (--supervised).");
    expect(supervised).not.toContain("Ctrl-C");
    expect(servingLine("box-1", "1 site")).toContain("Ctrl-C to stop.");
  });
});
