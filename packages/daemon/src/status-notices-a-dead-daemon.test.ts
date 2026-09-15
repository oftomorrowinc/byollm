import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { writeHealth } from "./health.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * `status` notices a daemon that has stopped writing — B201.
 *
 * On 09-15 box-1's daemon was gone. A `/proc` walk found two processes: the
 * console and the inspector one-liner somebody typed to look. **`status`
 * reported a working device**, and the only truthful instrument anybody had
 * was that hand-typed walk.
 *
 * Every part of the failure is ordinary:
 *
 * - `#recordHealth` stamps `at` on **every heartbeat**, so a live daemon
 *   refreshes the file every ten seconds;
 * - a dead one freezes `at` and leaves `consecutiveFailures` at whatever it
 *   was — **zero**, after a healthy run — so the `failing` arm never trips;
 * - `supervision.state` is `absent` on a box, because there is no systemd to
 *   ask;
 * - so the headline fell all the way through to **`running`**.
 *
 * **The honest signal was already on disk and the surface never asked** — the
 * same shape as the provenance model in B197, two rows apart, and the third
 * time this month that "check what is already written down" was the answer.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let errored: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  /* Collected and ignored: these cases assert on stdout, and a status that
     wrote to stderr would still be a status that printed the headline. */
  err: (text) => {
    errored += text;
  },
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-b201-"));
  paths = daemonPaths(home);
  out = "";
  errored = "";
});
afterEach(() => removeTemp(home));

const status = () =>
  runCli(["status"], { paths, io: io(), service: noSupervisor() });

/** A health file as a daemon that died `agoMs` ago would have left it. */
const healthWritten = (agoMs: number) =>
  writeHealth(paths.health, {
    at: Date.now() - agoMs,
    /* Zero, which is the point: a daemon that was working right up until it
       died leaves no failures behind, so the alarm that exists cannot see it. */
    consecutiveFailures: 0,
    origin: "https://hub.test",
  });

describe("a daemon that has stopped writing", () => {
  it("is reported NOT RUNNING, not running", async () => {
    await healthWritten(20 * 60_000);
    await status();

    expect(out).toContain("state: NOT RUNNING");
  });

  it("shows its working, because this headline has to be believed", async () => {
    /* "NOT RUNNING" from a surface that was wrong about exactly this an hour
       ago has to carry the evidence. The age IS the argument. */
    await healthWritten(20 * 60_000);
    await status();

    expect(out).toContain("health file");
    expect(out, "and how stale").toContain("20 minutes");
  });

  it("does not describe a stale file as the truth about now", async () => {
    /* Everything below the headline is read from that same frozen file. */
    await healthWritten(20 * 60_000);
    await status();

    expect(out).toContain("not what is true");
  });

  it("leaves a live daemon alone, which is the control", async () => {
    /**
     * Without this, a `status` that said NOT RUNNING unconditionally would
     * pass every case above — and would send somebody to restart a device
     * that is serving perfectly. **A false NOT RUNNING is the more expensive
     * error**, which is why the threshold is six missed heartbeats rather
     * than two.
     */
    await healthWritten(5_000);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
    expect(out).not.toContain("health file");
    /* And it is not quietly complaining on the other stream while printing a
       calm headline — a status that errors is a status somebody scripted
       against and did not notice. */
    expect(errored).toBe("");
  });

  it("is not fooled by a daemon that is alive and merely failing", async () => {
    /**
     * The two states are different and both already had words. A daemon whose
     * messages the hub rejects is **running and invisible** — `NOT REPORTING`
     * — and telling that owner their daemon is dead sends them to restart a
     * process that is doing its job.
     */
    await writeHealth(paths.health, {
      at: Date.now(),
      consecutiveFailures: 40,
      origin: "https://hub.test",
    });
    await status();

    expect(out).toContain("state: NOT REPORTING");
    expect(out).not.toContain("state: NOT RUNNING");
  });
});
