import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  runCli as RunCli,
  watchForUpdate as WatchForUpdate,
} from "./cli.js";
import { DAEMON_VERSION } from "./index.js";
import type { CommandRunner } from "./install.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import type { Runner } from "./runner.js";
import { SERVICE_LABEL } from "./service.js";

/**
 * After an update the service is installed and the new daemon is running —
 * #9572.
 *
 * 11-18, Todd's Mac Studio, the first real device to take an offer: 0.1.4's
 * updater installed 0.1.5, ran `byollm start` as its child to re-register,
 * and launchd's own log says what that child did:
 *
 *     booting out service: caller = launchctl[33584]<-node[33561]<-node[32458]
 *     service inactive: cloud.byollm.daemon
 *     removing service: cloud.byollm.daemon
 *
 * 32458 was the daemon. The bootout removed its job, launchd killed the job's
 * process group, and the `start` in that group never reached `bootstrap`.
 * No service, no daemon, until a person typed `byollm start`.
 *
 * ## The doubles, and what each was checked against
 *
 * **launchd.** Bootout kills every process in the job's group, mid-command:
 * the `launchctl bootout` a grouped child runs never returns to it. That is
 * not an assumption — it was run against the real launchd on the Mac Studio
 * with a throwaway label (`cloud.byollm.test9572`): a child in the job's
 * group logged "bootout…" and nothing after, and the service was gone; a
 * detached child logged both exits and the job came back. `KeepAlive` is
 * true in our plist, so a job that exits is started again, on whatever is
 * installed.
 *
 * **Task Scheduler** is modelled from our task XML and Microsoft's documented
 * semantics, NOT from a run on Windows: `IgnoreNew` means `/run` against a
 * running instance starts nothing, `/create /f` replaces the definition and
 * leaves the running instance alone, and a clean exit is not a failure
 * `RestartOnFailure` acts on. If any of those is wrong on a real machine the
 * Windows case below is describing a machine that does not exist.
 *
 * Everything between the doubles is the real code: `watchForUpdate`, the
 * real `update()` and `realUpdateDeps`, and the real `byollm start`.
 */

function above(steps: number): string {
  const core = /^(\d+)\.(\d+)\.(\d+)/u.exec(DAEMON_VERSION);
  if (core?.[1] === undefined || core[2] === undefined || core[3] === undefined)
    throw new Error(`unparseable DAEMON_VERSION: ${DAEMON_VERSION}`);
  return `${core[1]}.${core[2]}.${String(Number(core[3]) + steps)}`;
}
const NEW = above(1);

interface Proc {
  readonly pid: number;
  readonly group: number;
  readonly parent: number | undefined;
  readonly detached: boolean;
  readonly version: string | undefined;
  alive: boolean;
  end?: "exited" | "killed";
}

const never = new Promise<never>(() => undefined);

class Machine {
  readonly #procs = new Map<number, Proc>();
  #nextPid = 32458;
  installed = DAEMON_VERSION;
  registered = false;
  jobPid: number | undefined;
  readonly detachedRuns: Promise<unknown>[] = [];
  readonly said: string[] = [];
  #exited: () => void = () => undefined;
  /** Resolves when the original daemon exits on its own. */
  readonly daemonExited = new Promise<void>((resolve) => {
    this.#exited = resolve;
  });
  #died: (() => void) | undefined;
  /** Resolves when the original daemon stops being alive, for any reason. */
  readonly daemonGone = new Promise<void>((resolve) => {
    this.#died = resolve;
  });
  original: Proc | undefined;

  constructor(
    readonly platform: "darwin" | "win32",
    readonly paths: DaemonPaths,
    readonly home: string,
    readonly runCli: typeof RunCli,
  ) {}

  proc(pid: number | undefined): Proc | undefined {
    return pid === undefined ? undefined : this.#procs.get(pid);
  }

  #spawn(input: { parent?: Proc; detached?: boolean; daemon?: boolean }): Proc {
    const pid = this.#nextPid++;
    const proc: Proc = {
      pid,
      group:
        input.detached === true || input.parent === undefined
          ? pid
          : input.parent.group,
      parent: input.parent?.pid,
      detached: input.detached === true,
      version: input.daemon === true ? this.installed : undefined,
      alive: true,
    };
    this.#procs.set(pid, proc);
    return proc;
  }

  startJob(): Proc {
    const job = this.#spawn({ daemon: true });
    this.jobPid = job.pid;
    return job;
  }

  #end(proc: Proc, how: "exited" | "killed"): void {
    if (!proc.alive) return;
    proc.alive = false;
    proc.end = how;
    if (proc === this.original) this.#died?.();
  }

  /** launchd's bootout: the job's whole process group goes, mid-command. */
  #killJobGroup(): void {
    const job = this.proc(this.jobPid);
    if (job === undefined) return;
    for (const p of this.#procs.values()) {
      if (p.group === job.group) this.#end(p, "killed");
    }
  }

  /** The daemon returns from `run` after a kept update and exits 0. */
  daemonExits(proc: Proc): void {
    this.#end(proc, "exited");
    if (proc === this.original) this.#exited();
    /* KeepAlive is unconditional in our plist. Task Scheduler's restart is
       on failure only, and an exit of 0 is not one. */
    if (
      this.platform === "darwin" &&
      this.registered &&
      proc.pid === this.jobPid
    ) {
      this.startJob();
    }
  }

  /** Every command a process runs, as that process. A dead one runs nothing. */
  runAs(proc: Proc): CommandRunner {
    return async (command) => {
      if (!proc.alive) return never;
      const [file, ...args] = command;
      if (file === "npm") {
        this.installed = (command.at(-1) ?? "").replace("byollm@", "");
        return { code: 0, output: "" };
      }
      if (file === "byollm" && args[0] === "--version") {
        return { code: 0, output: `byollm ${this.installed} (protocol 2)\n` };
      }
      if (file === "byollm" && args[0] === "start") {
        /* The child the daemon spawns, in its process group, with its
           environment — launchd's XPC_SERVICE_NAME included. */
        const child = this.#spawn({ parent: proc });
        const code = await this.#start(child, this.#envOf(proc));
        return child.alive ? { code, output: "" } : never;
      }
      if (file === "launchctl") return this.#launchctl(proc, args);
      if (file === "schtasks") return this.#schtasks(args);
      return { code: 127, output: `no ${String(file)}` };
    };
  }

  #envOf(proc: Proc): NodeJS.ProcessEnv {
    return this.platform === "darwin" &&
      proc.group === this.proc(this.jobPid)?.group
      ? { XPC_SERVICE_NAME: SERVICE_LABEL }
      : {};
  }

  #launchctl(
    caller: Proc,
    args: readonly string[],
  ): { code: number; output: string } | Promise<never> {
    const [verb] = args;
    if (verb === "bootout") {
      if (!this.registered) return { code: 113, output: "No such process" };
      this.registered = false;
      this.#killJobGroup();
      /* The launchctl process is the caller's child, in the caller's group:
         if that group just died, so did it, and nothing comes back. */
      return caller.alive ? { code: 0, output: "" } : never;
    }
    if (verb === "bootstrap") {
      this.registered = true;
      this.startJob();
      return { code: 0, output: "" };
    }
    if (verb === "enable") return { code: 0, output: "" };
    if (verb === "print") {
      if (!this.registered) return { code: 113, output: "" };
      return this.proc(this.jobPid)?.alive === true
        ? { code: 0, output: "state = running\n" }
        : { code: 0, output: "state = not running\nlast exit code = 0\n" };
    }
    return { code: 1, output: "" };
  }

  #schtasks(args: readonly string[]): { code: number; output: string } {
    const [verb] = args;
    const running = this.proc(this.jobPid)?.alive === true;
    if (verb === "/create") {
      this.registered = true;
      return { code: 0, output: "SUCCESS" };
    }
    if (verb === "/run") {
      // IgnoreNew: a running instance means nothing new starts.
      if (this.registered && !running) this.startJob();
      return { code: 0, output: "SUCCESS: Attempted to run" };
    }
    if (verb === "/query") {
      if (!this.registered) return { code: 1, output: "" };
      return { code: 0, output: running ? "Running\n" : "Ready\n" };
    }
    return { code: 1, output: "" };
  }

  #start(proc: Proc, env: NodeJS.ProcessEnv): Promise<number> {
    let said = "";
    const io = {
      out: (t: string) => (said += t),
      err: (t: string) => (said += t),
    };
    return this.runCli(["start"], {
      paths: this.paths,
      io,
      interactive: false,
      verify: () => Promise.resolve({ answers: true }),
      service: {
        platform: this.platform,
        execPath: "/n/node",
        scriptPath: "/n/bin/byollm",
        run: this.runAs(proc),
        home: this.home,
        appData: join(this.home, "AppData"),
        uid: 501,
        env,
        ...(proc.parent === undefined ? {} : { parentPid: proc.parent }),
        /* Only the detached copy ever waits for the old daemon, and it
           waits for real: until that daemon has exited. Every other wait
           (the install's own probes) is immediate. */
        wait: () => (proc.detached ? this.daemonGone : Promise.resolve()),
        isGone: (pid) => this.proc(pid)?.alive !== true,
        detach: (_command, childEnv) => {
          const copy = this.#spawn({ parent: proc, detached: true });
          this.detachedRuns.push(this.#start(copy, childEnv));
          return Promise.resolve(true);
        },
      },
    }).then((code) => {
      this.said.push(said);
      return code;
    });
  }
}

function fakeRunner(): Runner {
  return {
    drain: () => Promise.resolve(),
    resumeClaiming: () => undefined,
  } as unknown as Runner;
}

describe("after an update the service is installed and the new daemon is running — #9572", () => {
  let runCli: typeof RunCli;
  let watchForUpdate: typeof WatchForUpdate;
  beforeAll(async () => {
    ({ runCli, watchForUpdate } = await import("./cli.js"));
  }, 30_000);

  async function machine(
    platform: "darwin" | "win32",
    heartbeat: "written" | "not yet",
  ): Promise<Machine> {
    const home = await mkdtemp(join(tmpdir(), "byollm-9572-"));
    const paths = daemonPaths(join(home, ".byollm"));
    const m = new Machine(platform, paths, home, runCli);
    m.registered = true;
    m.original = m.startJob();
    await mkdir(paths.root, { recursive: true });
    if (heartbeat === "written") {
      await writeFile(
        paths.heartbeat,
        JSON.stringify({ at: Date.now(), pid: m.original.pid }),
      );
    }
    return m;
  }

  /** The daemon takes the offer; if it survives that, it exits, as `run` does. */
  async function takeTheUpdate(m: Machine): Promise<void> {
    const daemon = m.original;
    if (daemon === undefined) throw new Error("no daemon");
    const updating = watchForUpdate({
      runners: [fakeRunner()],
      io: {
        out: () => undefined,
        err: () => undefined,
        confirm: () => Promise.resolve(false),
      },
      signal: new AbortController().signal,
      offered: () => NEW,
      verify: () => Promise.resolve({ verified: true } as const),
      wait: () => Promise.resolve(),
      drainMs: 1,
      run: m.runAs(daemon),
    });
    /* Either the updater returns, or the daemon running it is killed under
       it — the second is what Todd's Mac did, and it must end the test with
       a verdict rather than a hang. */
    const took = await Promise.race([
      updating,
      m.daemonGone.then(() => "killed" as const),
    ]);
    if (took === true) m.daemonExits(daemon);
    await Promise.all(m.detachedRuns);
  }

  function expectServing(m: Machine): void {
    const job = m.proc(m.jobPid);
    expect(m.registered, "the service is still installed").toBe(true);
    expect(job?.alive, "a daemon is running under it").toBe(true);
    expect(job?.version, "and it is the version just installed").toBe(NEW);
  }

  it("on launchd, as on Todd's Mac: the heartbeat names the daemon", async () => {
    const m = await machine("darwin", "written");
    await takeTheUpdate(m);
    expectServing(m);
    /* It exited on its own, after the update was kept — not booted out from
       under the updater, which is what happened on 11-18. */
    expect(m.original?.end).toBe("exited");
  });

  it("on launchd, when the offer lands before the first heartbeat is on disk", async () => {
    /* Todd's daemon took the offer four seconds after it started. The beat
       is fire-and-forget, so `start` cannot count on it; launchd's
       XPC_SERVICE_NAME in the inherited environment is what says it. */
    const m = await machine("darwin", "not yet");
    await takeTheUpdate(m);
    expectServing(m);
    expect(m.original?.end).toBe("exited");
  });

  it("on Task Scheduler, where re-running a running task starts nothing", async () => {
    const m = await machine("win32", "written");
    await takeTheUpdate(m);
    expectServing(m);
  });

  /**
   * The case that decides who this fix reaches.
   *
   * A device runs the updater of the version it is ON. 0.1.4's and 0.1.5's
   * are byte-identical to each other (`git diff v0.1.4 v0.1.5 --
   * packages/daemon/src/update.ts` is empty) and re-register BEFORE the
   * canary, from inside the daemon — the order that killed Todd's Mac. What
   * they run as `byollm start` is the binary they just installed, which is
   * this one. So this is their success path, transcribed from v0.1.4's
   * `update()` and `watchForUpdate`, against today's `start`.
   */
  it.each(["darwin", "win32"] as const)(
    "a device still on 0.1.4 or 0.1.5, running its own updater, comes back up (%s)",
    async (platform) => {
      const m = await machine(platform, "written");
      const daemon = m.original;
      if (daemon === undefined) throw new Error("no daemon");
      const run = m.runAs(daemon);
      const transcribed = (async () => {
        await run([
          "npm",
          "install",
          "--global",
          "--ignore-scripts",
          `byollm@${NEW}`,
        ]);
        await run(["byollm", "start"]); // reregister, before the canary
        const said = await run(["byollm", "--version"]);
        return said.output.startsWith(`byollm ${NEW}`);
      })();
      const took = await Promise.race([
        transcribed,
        m.daemonGone.then(() => "killed" as const),
      ]);
      expect(took, "0.1.4's updater sees its canary pass and exits").toBe(true);
      m.daemonExits(daemon);
      await Promise.all(m.detachedRuns);
      expectServing(m);
    },
  );

  it("does not hand off when a person runs `start` from a terminal", async () => {
    /* The everyday path: no launchd job environment, and the parent is a
       shell, not the daemon. It installs in place, as it always has. */
    const m = await machine("darwin", "written");
    let out = "";
    const code = await runCli(["start"], {
      paths: m.paths,
      io: { out: (t) => (out += t), err: (t) => (out += t) },
      interactive: false,
      verify: () => Promise.resolve({ answers: true }),
      service: {
        platform: "darwin",
        execPath: "/n/node",
        scriptPath: "/n/bin/byollm",
        run: (command) =>
          Promise.resolve(
            command[1] === "print"
              ? { code: 0, output: "state = running\n" }
              : { code: 0, output: "" },
          ),
        home: m.home,
        uid: 501,
        env: { XPC_SERVICE_NAME: "application.com.googlecode.iterm2" },
        parentPid: 1064,
        wait: () => Promise.resolve(),
        detach: () => {
          throw new Error("a person's `start` must not hand off");
        },
      },
    });
    expect(code).toBe(0);
    expect(out).not.toContain("finishes once that daemon exits");
  });
});

/**
 * The two real hands the doubles above stand in for. A hand-off that the
 * fakes prove and the real spawn does not perform is a fix on paper.
 */
describe("the hand-off's real process calls — #9572", () => {
  /* POSIX only: a process group is what launchd's bootout reaches, and `ps`
     is how the child names its own. Windows has neither, and its half of
     this is modelled above, not run. */
  it.skipIf(process.platform === "win32")(
    "starts a command that outlives the wait, in its own session, writing to the log",
    async () => {
      const { spawnDetached, processIsGone } = await import("./install.js");
      const dir = await mkdtemp(join(tmpdir(), "byollm-9572-detach-"));
      const log = join(dir, "logs", "service.log");
      const started = Date.now();
      /* The child sleeps longer than spawnDetached may take. If it waited for
       the child — or held a pipe the caller waits on — this would take the
       child's full second. */
      const ok = await spawnDetached(
        [
          process.execPath,
          "-e",
          "const{execSync}=require('node:child_process');" +
            "console.log('pgid', execSync('ps -o pgid= -p '+process.pid).toString().trim(), 'pid', process.pid);" +
            "setTimeout(()=>console.log('done'),1000)",
        ],
        process.env,
        log,
      );
      expect(ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(900);

      const { readFile } = await import("node:fs/promises");
      let text = "";
      for (let i = 0; i < 60 && !text.includes("done"); i++) {
        await new Promise((r) => setTimeout(r, 50));
        text = await readFile(log, "utf8").catch(() => "");
      }
      expect(text).toContain("done");
      /* Its own process group: the group id is its own pid, which is what
       launchd's bootout does not reach. */
      const found = /pgid (\d+) pid (\d+)/.exec(text);
      expect(found?.[1]).toBe(found?.[2]);
      expect(found?.[1]).not.toBe(String(process.pid));
      /* 'done' is written before the child exits, and the exit is reaped some
       time after that, so kill(pid, 0) can still succeed for a moment. Poll
       for the exit (bounded), then assert it. */
      const pid = Number(found?.[2]);
      let gone = processIsGone(pid);
      for (let i = 0; i < 40 && !gone; i++) {
        await new Promise((r) => setTimeout(r, 50));
        gone = processIsGone(pid);
      }
      expect(gone).toBe(true);
    },
    /* Bounded waits: up to 3s for 'done', then up to 2s for the exit. */
    10_000,
  );

  it("says false when the command cannot be started at all", async () => {
    const { spawnDetached } = await import("./install.js");
    const dir = await mkdtemp(join(tmpdir(), "byollm-9572-detach-"));
    expect(
      await spawnDetached(
        [join(dir, "no-such-binary")],
        process.env,
        join(dir, "service.log"),
      ),
    ).toBe(false);
  });

  it("calls the running process alive", async () => {
    const { processIsGone } = await import("./install.js");
    expect(processIsGone(process.pid)).toBe(false);
  });
});
