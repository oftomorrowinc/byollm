import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { writeHealth } from "./health.js";
import { writeHeartbeat } from "./heartbeat.js";
import { Pairings } from "./pairings.js";
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
 * `consecutiveFailures` sat at **zero** — a daemon that was working right up
 * until it died leaves no failures behind — `supervision.state` is `absent` on
 * a box with no systemd to ask, and so the headline fell all the way through
 * to **`running`**.
 *
 * ## The first fix read the wrong file, and these cases now say so
 *
 * It used `health.json`'s `at` as a per-beat stamp. **It is not one**, and the
 * line three above its call site says so: health is *"written on the
 * transition rather than every beat, so a healthy daemon is not rewriting a
 * file every ten seconds to say nothing changed."*
 *
 * Wrong in both directions at once — an ABSENT file left a dead daemon reading
 * `running`, and a daemon that failed once and RECOVERED froze `at` at the
 * recovery and read `NOT RUNNING` a minute later while serving perfectly. Both
 * are cases below now, because each was a shipped bug for a few hours.
 *
 * `heartbeat.json` (B202) is written every beat and overwritten in place, so
 * its age means what this arm needs it to mean.
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

/** A device somebody set up, so it is meant to be serving. */
const paired = async () => {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  await pairings.put({
    origin: "https://hub.test",
    runnerId: "runner_1",
    owner: "me",
    sites: {},
    pairedAt: Date.now(),
  });
};

/** A beat as a daemon that died `agoMs` ago would have left it. */
const beatWritten = (agoMs: number) =>
  writeHeartbeat(paths.heartbeat, {
    at: Date.now() - agoMs,
    pid: 4242,
  });

describe("a daemon that has stopped writing", () => {
  it("is reported NOT RUNNING, not running", async () => {
    await beatWritten(20 * 60_000);
    await status();

    expect(out).toContain("state: NOT RUNNING");
  });

  it("shows its working, because this headline has to be believed", async () => {
    /* "NOT RUNNING" from a surface that was wrong about exactly this an hour
       ago has to carry the evidence. The age IS the argument. */
    await beatWritten(20 * 60_000);
    await status();

    expect(out).toContain("heartbeat");
    expect(out, "and how stale").toContain("20 minutes");
  });

  it("does not describe a stale file as the truth about now", async () => {
    /* Everything below the headline is read from that same frozen file. */
    await beatWritten(20 * 60_000);
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
    await beatWritten(5_000);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
    expect(out).not.toContain("nothing has written");
    /* And it is not quietly complaining on the other stream while printing a
       calm headline — a status that errors is a status somebody scripted
       against and did not notice. */
    expect(errored).toBe("");
  });

  it("catches a paired device whose daemon never beat at all", async () => {
    /**
     * box-1's exact shape, and **the first fix missed it entirely**: an absent
     * file made `health !== undefined` false, so `stale` was false and the
     * headline still said `running` — the motivating bug, unfixed by the fix.
     *
     * Absent counts only for a device somebody has PAIRED. A machine nobody
     * has set up has no daemon for an honest reason, and the screen says that
     * better further down.
     */
    await paired();
    await status();

    expect(out).toContain("state: NOT RUNNING");
  });

  it("says nothing of the sort on a machine nobody has set up", async () => {
    /* No pairing and no beat is not a dead daemon — it is a machine waiting to
       be set up, and telling that person their daemon died would send them
       looking for something that never existed. */
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
  });

  it("does not call a recovered daemon dead — the other false premise", async () => {
    /**
     * The expensive false positive the first fix shipped. A daemon that failed
     * once and recovered writes health at the **recovery** and then never
     * again while healthy, so its `at` froze and `status` called it dead sixty
     * seconds later while it was serving perfectly.
     *
     * Health is old here on purpose; the beat is fresh. Liveness comes from
     * the beat, and the durable alert stays exactly where it was.
     */
    await paired();
    await writeHealth(paths.health, {
      at: Date.now() - 20 * 60_000,
      consecutiveFailures: 0,
      origin: "https://hub.test",
    });
    await beatWritten(5_000);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
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
    await beatWritten(2_000);
    await status();

    expect(out).toContain("state: NOT REPORTING");
    expect(out).not.toContain("state: NOT RUNNING");
  });
});
