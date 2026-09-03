import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { installService } from "./install.js";
import { writeHealth } from "./health.js";
import { REVOKED_SENTENCE, clearRevokedMark, revokedMark } from "./revoked.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * The mark is rendered wherever the person looks — ruled 2026-09-03.
 *
 * Todd revoked `todd-mbp-2023`, upgraded, and ran `byollm install`. Three
 * surfaces answered and none of them said revoked: `status` printed "state:
 * running" two lines above "service: installed but NOT running", `install`
 * said "retry: byollm install", and the service log said "No apps are paired
 * yet" — for a machine that was paired and had been revoked.
 *
 * **A mark nobody renders is a destroy with extra steps.** The whole point of
 * marks-never-destroys is that the surfaces can read the mark; until they did,
 * keeping the file bought nothing a person could see.
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
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-mark-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
});

afterEach(() => removeTemp(home));

/** A device the hub has refused outright. */
const mark = () =>
  writeHealth(paths.health, {
    at: Date.now(),
    consecutiveFailures: 1,
    origin: "https://hub.test",
    revoked: { at: Date.now(), origin: "https://hub.test" },
  });

describe("byollm status, on a revoked device", () => {
  it("says it, and names re-pairing as the remedy", async () => {
    await mark();
    await runCli(["status"], { paths, io: io(), service: noSupervisor() });

    expect(out).toContain(REVOKED_SENTENCE);
    expect(out).toContain("byollm connect");
  });

  it("does not claim to be running", async () => {
    /**
     * The self-contradiction, ruled out — "state: running" two lines above
     * "service: NOT running" is one display holding two truths, and a status
     * that disagrees with itself teaches the reader to trust neither line.
     */
    await mark();
    await runCli(["status"], { paths, io: io(), service: noSupervisor() });

    expect(out).toContain("state: REVOKED");
    expect(out).not.toContain("state: running");
  });

  it("says nothing about revocation on an ordinary device", async () => {
    // The control. A sentence printed unconditionally would pass every case
    // above while telling every healthy machine it had been revoked.
    await runCli(["status"], { paths, io: io(), service: noSupervisor() });
    expect(out).not.toContain(REVOKED_SENTENCE);
  });
});

describe("byollm run, on a revoked device with nothing left to serve", () => {
  it("says revoked rather than never-paired", async () => {
    /**
     * The sharpener: the exit path chose its sentence without consulting the
     * mark, so a revoked machine was told its setup had never finished. Both
     * remedies happen to be `connect`, which is exactly why it survived — the
     * wrong sentence sent people somewhere useful by luck.
     */
    await mark();
    await runCli(["run"], {
      paths,
      io: io(),
      service: noSupervisor(),
      signal: AbortSignal.abort(),
    });

    expect(err).toContain(REVOKED_SENTENCE);
    expect(err).not.toContain("No app is paired");
  });

  it("still says never-paired when that is the truth", async () => {
    // The other half of the same branch, and the control for it.
    await runCli(["run"], {
      paths,
      io: io(),
      service: noSupervisor(),
      signal: AbortSignal.abort(),
    });

    expect(err).toContain("No app is paired");
    expect(err).not.toContain(REVOKED_SENTENCE);
  });
});

describe("a revoked daemon under a supervisor", () => {
  it("waits instead of exiting, so nothing restarts it", async () => {
    /**
     * Ruled 2026-09-03 (4). Exit(2) under launchd means boot → refused →
     * exit → restart, every ten seconds, forever. Todd watched his own
     * machine do it, and each turn is a request the hub answers only to say
     * no again — a real cost paid by the fleet for a device that is never
     * coming back without a re-pair.
     *
     * So it stays up, marked, serving nothing. The sentence is its status.
     */
    await mark();
    const stop = new AbortController();
    let settled: number | undefined;
    const running = runCli(["run"], {
      paths,
      io: io(),
      service: noSupervisor(),
      signal: stop.signal,
    }).then((code) => (settled = code));

    await new Promise((r) => setTimeout(r, 60));
    expect(settled, "it exited, and the supervisor will start it again").toBe(
      undefined,
    );
    // It said why before settling in to wait — silence would be the old bug
    // wearing patience.
    expect(err).toContain(REVOKED_SENTENCE);

    stop.abort();
    await running;
    // Zero, not two: this is an orderly stop, not a failure to start.
    expect(settled).toBe(0);
  }, 20_000);

  it("exits for somebody at a prompt", async () => {
    /* The control, and the reason `supervised` is not simply always true: a
       command that hangs after printing why it cannot work is its own small
       cruelty. Asserted through `runLoop`'s own default being overridden the
       way a TTY would. */
    await mark();
    const { runCli: fresh } = await import("./cli.js");
    const wasTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const code = await fresh(["run"], {
        paths,
        io: io(),
        service: noSupervisor(),
      });
      expect(code).toBe(2);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: wasTty,
        configurable: true,
      });
    }
  }, 20_000);
});

describe("byollm install, on a revoked device", () => {
  const target = () => ({
    platform: "darwin" as const,
    execPath: join(home, "node"),
    scriptPath: join(home, "bin.js"),
    home,
    root: join(home, ".byollm"),
  });
  const dead = (command: readonly string[]) =>
    Promise.resolve({
      code: 0,
      output:
        command[1] === "print"
          ? "state = not running\n\tlast exit code = 2"
          : "",
    });

  it("names the cause, and does not tell them to retry", async () => {
    /**
     * A remedy must match the cause. Installing again cannot fix a
     * revocation: the daemon starts, is refused, and stops, every time. The
     * old line sent somebody to run the same failure on a loop.
     */
    const result = await installService(
      target(),
      dead,
      () => Promise.resolve(),
      true,
    );

    expect(result.ok).toBe(false);
    const said = result.lines.join("\n");
    expect(said).toContain(REVOKED_SENTENCE);
    expect(said).toContain("byollm connect");
    expect(said).not.toContain("retry:    byollm install");
  });

  it("keeps the retry line when retrying is the right advice", async () => {
    // The control. A failed install that is *not* a revocation is exactly the
    // case where trying again is the first thing to do.
    const result = await installService(
      target(),
      dead,
      () => Promise.resolve(),
      false,
    );
    expect(result.lines.join("\n")).toContain("retry:    byollm install");
  });
});

describe("the mark and its remedy", () => {
  it("is cleared by the thing that fixes it", async () => {
    /* A mark that outlived re-pairing would tell a working device it cannot
       serve — the same class of lie as a status line outliving the consent it
       reports. */
    await mark();
    expect(await revokedMark(paths.health)).toBeDefined();

    await clearRevokedMark(paths.health);
    expect(await revokedMark(paths.health)).toBeUndefined();
  });

  it("keeps the rest of the record when it clears", async () => {
    // It clears one field. What the daemon knows about its upstream is not
    // this function's to throw away.
    await mark();
    await clearRevokedMark(paths.health);
    const raw = JSON.parse(
      await (await import("node:fs/promises")).readFile(paths.health, "utf8"),
    ) as { origin?: string; consecutiveFailures?: number };
    expect(raw.origin).toBe("https://hub.test");
    expect(raw.consecutiveFailures).toBe(1);
  });

  it("is nothing to clear on a device that was never revoked", async () => {
    await writeFile(paths.health, "", "utf8");
    await expect(clearRevokedMark(paths.health)).resolves.toBeUndefined();
  });
});
