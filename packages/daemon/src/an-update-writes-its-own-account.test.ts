import { appendFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, watchForUpdate } from "./cli.js";
import { DAEMON_VERSION } from "./index.js";
import { IngressLog } from "./ingress.js";
import type { CommandRunner } from "./install.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import type { Runner } from "./runner.js";
import { servicePlan } from "./service.js";
import { noSupervisor, POSIX_HOST } from "./test-support.js";
import {
  announceArrival,
  rememberUpdate,
  updateJournal,
} from "./update-journal.js";

/**
 * Every update writes its own account, on success as well as failure — #9594.
 *
 * On 11-18 two Macs took 0.1.5 and ended with no daemon (#9572), and
 * `grep -n update ~/.byollm/service.log` on the Mac Studio found nothing.
 * These cases read the two files an owner can read afterwards — the service
 * log the supervisor writes the daemon's stderr to, and the ingress log
 * `byollm logs` renders — never a list a fake reporter collected.
 *
 * Between the files and the commands is the real code: `watchForUpdate`,
 * `update()`, `realUpdateDeps`, the journal, and `byollm logs`. The command
 * runner is the double, because what npm and `byollm start` do is not the
 * subject; what the daemon writes about them is.
 */

function above(steps: number): string {
  const core = /^(\d+)\.(\d+)\.(\d+)/u.exec(DAEMON_VERSION);
  if (core?.[1] === undefined || core[2] === undefined || core[3] === undefined)
    throw new Error(`unparseable DAEMON_VERSION: ${DAEMON_VERSION}`);
  return `${core[1]}.${core[2]}.${String(Number(core[3]) + steps)}`;
}
const NEW = above(1);
const HUB = "https://hub.byo-llm.com";
const OLD = DAEMON_VERSION;

/**
 * A value the daemon's environment holds and no line may ever carry.
 *
 * Deliberately not shaped like any credential: it must be removed because
 * the environment holds it under a credential's name, not because a pattern
 * recognises it — and a real token's shape in the tree fails the secret scan.
 */
const SECRET_NAME = "NPM_TOKEN";
const SECRET = "planted-value-not-a-credential-7f3a";

beforeEach(() => {
  vi.stubEnv(SECRET_NAME, SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

interface Device {
  readonly paths: DaemonPaths;
  /** launchd's StandardErrorPath — and systemd's, and the Windows shim's. */
  readonly serviceLog: string;
  readonly ingress: IngressLog;
  /** The daemon's stderr, as the supervisor's redirect has it: the file. */
  readonly err: (text: string) => void;
}

async function device(): Promise<Device> {
  const home = await mkdtemp(join(tmpdir(), "byollm-9594-"));
  const paths = daemonPaths(join(home, ".byollm"));
  const serviceLog = servicePlan({
    platform: "darwin",
    execPath: "/n/node",
    scriptPath: "/n/bin/byollm",
    home,
  }).logPath;
  await mkdir(paths.root, { recursive: true });
  return {
    paths,
    serviceLog,
    ingress: new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: false,
    }),
    err: (text) => {
      appendFileSync(serviceLog, text);
    },
  };
}

function runner(tally: { finished: number; stillRunning: number }): Runner {
  return {
    drain: () => Promise.resolve(tally),
    resumeClaiming: () => undefined,
  } as unknown as Runner;
}

/**
 * npm and the installed binary. `npm` installs whatever it is asked for
 * unless `failInstall` names that version; `--version` answers with what is
 * installed; `start` says what #9572's hand-off says.
 */
function machine(
  options: { failInstall?: readonly string[]; startSays?: string } = {},
): {
  run: CommandRunner;
} {
  let installed = OLD;
  return {
    run: (command) => {
      const [file, ...args] = command;
      if (file === "npm") {
        const version = (command.at(-1) ?? "").replace("byollm@", "");
        if (options.failInstall?.includes(version) === true) {
          return Promise.resolve({
            code: 243,
            output:
              `npm ERR! code EACCES\n` +
              `npm ERR! using ${SECRET_NAME}=${SECRET} from the environment\n` +
              `npm ERR! permission denied, mkdir '/usr/local/lib/node_modules/byollm'\n`,
          });
        }
        installed = version;
        return Promise.resolve({ code: 0, output: "" });
      }
      if (file === "byollm" && args[0] === "--version") {
        return Promise.resolve({
          code: 0,
          output: `byollm ${installed} (protocol 2)\nnode 24.18.0\n`,
        });
      }
      if (file === "byollm" && args[0] === "start") {
        return Promise.resolve({
          code: 0,
          output:
            options.startSays ??
            `byollm start was run by the daemon it re-registers (pid 32458); ` +
              `it finishes once that daemon exits. See /Users/todd/.byollm/service.log\n`,
        });
      }
      return Promise.resolve({ code: 127, output: `no ${String(file)}` });
    },
  };
}

/** Take one offer the way the serving daemon does, until it settles. */
async function takeOffer(
  d: Device,
  input: {
    run: CommandRunner;
    verified?: boolean;
    tally?: { finished: number; stillRunning: number };
  },
): Promise<boolean> {
  const controller = new AbortController();
  const journal = updateJournal({ err: d.err, ingress: d.ingress });
  const took = await watchForUpdate({
    host: POSIX_HOST,
    runners: [runner(input.tally ?? { finished: 2, stillRunning: 0 })],
    io: {
      out: () => undefined,
      err: d.err,
      confirm: () => Promise.resolve(false),
    },
    signal: controller.signal,
    offered: () => NEW,
    offeredBy: () => HUB,
    journal,
    lastUpdate: d.paths.lastUpdate,
    verify: () =>
      Promise.resolve(
        input.verified === false
          ? ({
              verified: false,
              why: "there is no SLSA provenance for it",
            } as const)
          : ({ verified: true } as const),
      ),
    /* The watcher keeps watching after a failure, by design; the second
       look is where this test stops it. */
    wait: () => {
      controller.abort();
      return Promise.resolve();
    },
    drainMs: 1,
    run: input.run,
  });
  await journal.settled();
  return took;
}

/** The update's lines in the service log, without their time. */
async function serviceLines(d: Device): Promise<string[]> {
  const raw = await readFile(d.serviceLog, "utf8");
  const lines = raw.split("\n").filter((line) => line.startsWith("update:"));
  for (const line of lines) {
    expect(line, "every line carries its time, in UTC").toMatch(
      /^update: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \S/u,
    );
  }
  return lines.map((line) => line.replace(/^update: \S+ /u, ""));
}

/** What `byollm logs` prints, as an owner at a console would read it. */
async function byollmLogs(d: Device): Promise<string> {
  let out = "";
  const code = await runCli(["logs", "--tail", "50"], {
    paths: d.paths,
    io: { out: (t) => (out += t), err: (t) => (out += t) },
  });
  expect(code).toBe(0);
  return out;
}

/** Each expected line, in this order, and the account holds nothing else. */
function expectAccount(lines: readonly string[], expected: readonly RegExp[]) {
  expect(lines, lines.join("\n")).toHaveLength(expected.length);
  expected.forEach((shape, i) => {
    expect(lines[i], `line ${String(i + 1)}`).toMatch(shape);
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const V = escape(NEW);
const W = escape(OLD);

describe("every update writes its own account to the service log — #9594", () => {
  it("a successful update: each step, then the new daemon saying what it is", async () => {
    const d = await device();
    const took = await takeOffer(d, {
      run: machine().run,
      tally: { finished: 2, stillRunning: 0 },
    });
    expect(took, "the update was kept").toBe(true);

    /* The supervisor starts the new binary; the first thing it does is
       read what the old one left, as `serve` does. */
    await announceArrival({
      path: d.paths.lastUpdate,
      running: NEW,
      journal: updateJournal({ err: d.err, ingress: d.ingress }),
    });

    const lines = await serviceLines(d);
    expectAccount(lines, [
      new RegExp(
        `^offer of ${V} taken from ${escape(HUB)}, while running ${W}$`,
      ),
      /^drained in \d+\.\d s — 2 jobs finished$/u,
      new RegExp(`^installed ${V} in \\d+\\.\\d s$`),
      new RegExp(`^provenance verified: our release workflow built ${V}$`),
      new RegExp(
        `^the installed binary says ${V}; re-registering with the supervisor \\(byollm start\\)$`,
      ),
      /^byollm start said: .*re-registers \(pid 32458\); it finishes once that daemon exits/u,
      new RegExp(
        `^byollm start handed the re-register to a copy that finishes after this daemon exits ` +
          `\\(its lines follow in this log, without "update:"\\); ${V} is kept and this daemon exits — ` +
          `if no "update: now running" line follows, run \`byollm start\`$`,
      ),
      new RegExp(
        `^now running ${V}, was ${W} \\(the update to it began \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\)$`,
      ),
    ]);

    /* Said once: the next start has nothing to announce. */
    await expect(access(d.paths.lastUpdate)).rejects.toThrow();

    const shown = await byollmLogs(d);
    for (const line of lines) expect(shown).toContain(`update: ${line}`);
  });

  it("a start that registered (systemd, the box) says re-registered", async () => {
    /* No hand-off off launchd and Task Scheduler: `start` registers before
       it returns, so the account may say it happened — Owl on #9594. */
    const d = await device();
    const took = await takeOffer(d, {
      run: machine({ startSays: "Installed and started the systemd unit.\n" })
        .run,
    });
    expect(took).toBe(true);
    const lines = await serviceLines(d);
    expect(lines.at(-2)).toBe(
      "byollm start said: Installed and started the systemd unit.",
    );
    expect(lines.at(-1)).toMatch(
      new RegExp(
        `^re-registered; ${V} is kept and this daemon exits so the supervisor starts it$`,
      ),
    );
  });

  it("a failed install: the steps up to it, npm's words, and that nothing changed", async () => {
    const d = await device();
    const took = await takeOffer(d, {
      run: machine({ failInstall: [NEW] }).run,
      tally: { finished: 0, stillRunning: 0 },
    });
    expect(took, "the daemon goes on serving the version it had").toBe(false);

    const lines = await serviceLines(d);
    expectAccount(lines, [
      new RegExp(
        `^offer of ${V} taken from ${escape(HUB)}, while running ${W}$`,
      ),
      /^drained in \d+\.\d s — nothing was running$/u,
      new RegExp(
        `^npm install byollm@${V} failed \\(exit 243\\): npm ERR! code EACCES .*permission denied`,
      ),
      new RegExp(
        `^could not install ${V} — staying on ${W}: npm left ${W} in place after \\d+\\.\\d s, ` +
          `so nothing needs rolling back, and this daemon goes back to work$`,
      ),
    ]);
    await expect(
      access(d.paths.lastUpdate),
      "nothing for a next daemon to announce",
    ).rejects.toThrow();

    const raw = await readFile(d.serviceLog, "utf8");
    expect(raw, "the environment's token is never written").not.toContain(
      SECRET,
    );
    expect(raw).toContain(`[redacted ${SECRET_NAME}]`);
    const ingress = await readFile(d.paths.ingressLog, "utf8");
    expect(ingress).not.toContain(SECRET);

    const shown = await byollmLogs(d);
    for (const line of lines) expect(shown).toContain(`update: ${line}`);
    expect(shown).not.toContain(SECRET);
  });

  it("a rollback: why it failed, and that the machine is back on what it ran", async () => {
    const d = await device();
    const took = await takeOffer(d, {
      run: machine().run,
      verified: false,
      tally: { finished: 0, stillRunning: 1 },
    });
    expect(took).toBe(false);

    const lines = await serviceLines(d);
    expectAccount(lines, [
      new RegExp(
        `^offer of ${V} taken from ${escape(HUB)}, while running ${W}$`,
      ),
      /^drained in \d+\.\d s — 1 job still running when the wait ran out$/u,
      new RegExp(`^installed ${V} in \\d+\\.\\d s$`),
      new RegExp(
        `^${V} failed its provenance check: there is no SLSA provenance for it; rolling back to ${W}$`,
      ),
      new RegExp(
        `^${V} failed its provenance check: .*; rolled back to ${W}, which the installed binary confirms — ` +
          `this daemon goes back to work on it$`,
      ),
    ]);
    expect(lines.join("\n"), "never re-registered").not.toContain(
      "byollm start",
    );

    const shown = await byollmLogs(d);
    for (const line of lines) expect(shown).toContain(`update: ${line}`);
  });

  it("a stranded machine: what failed, and what its owner should run", async () => {
    const d = await device();
    await takeOffer(d, {
      run: machine({ failInstall: [OLD] }).run,
      verified: false,
    });

    const lines = await serviceLines(d);
    const last = lines.at(-1) ?? "";
    expect(last).toContain(`rolling back to ${OLD} also failed`);
    expect(last).toContain("stranded");
    expect(last).toContain(
      `Run \`npm install --global byollm@${OLD}\` and then \`byollm start\``,
    );
    expect(await byollmLogs(d)).toContain(`update: ${last}`);
  });

  it("`byollm run` says it at startup, before anything can park it", async () => {
    /* The real daemon's start, with nothing paired: the line is said before
       preflight and pairings get a chance to end the run. */
    const d = await device();
    await rememberUpdate(d.paths.lastUpdate, {
      from: "0.1.4",
      to: DAEMON_VERSION,
      at: Date.UTC(2026, 10, 18, 9, 14, 3),
    });
    await runCli(["run"], {
      paths: d.paths,
      io: { out: () => undefined, err: d.err },
      service: noSupervisor(),
      signal: AbortSignal.abort(),
    });

    const lines = await serviceLines(d);
    expect(lines).toEqual([
      `now running ${OLD}, was 0.1.4 (the update to it began 2026-11-18T09:14:03Z)`,
    ]);
    expect(await byollmLogs(d)).toContain(`update: ${lines[0] ?? ""}`);
    await expect(access(d.paths.lastUpdate)).rejects.toThrow();
  });

  it("a daemon that came up on something other than what was installed says so", async () => {
    /* The update installed NEW, and what the supervisor started is this
       binary — the old one. */
    const d = await device();
    await takeOffer(d, { run: machine().run });
    await runCli(["run"], {
      paths: d.paths,
      io: { out: () => undefined, err: d.err },
      service: noSupervisor(),
      signal: AbortSignal.abort(),
    });
    const last = (await serviceLines(d)).at(-1) ?? "";
    expect(last).toMatch(
      new RegExp(
        `^now running ${W}, not the ${V} the last update installed over ${W}`,
      ),
    );
  });
});
