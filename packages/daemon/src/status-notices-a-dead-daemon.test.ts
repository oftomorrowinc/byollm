import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

/**
 * A pid nothing holds — B228.
 *
 * Spawned and reaped rather than typed, because a typed number is a guess: on
 * a busy machine `4242` may well be somebody's process, and a case asserting
 * NOT RUNNING because that pid is absent would flip to green-or-red by
 * coincidence. A pid we watched exit is gone for a real reason.
 *
 * Reuse could in principle hand it to something else between the exit and the
 * read. That would make these cases FAIL rather than falsely pass, because the
 * check under test may only demote — which is the property that makes this
 * fixture safe to use at all.
 */
let deadPid: number;

beforeAll(async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  deadPid = child.pid ?? 0;
  await new Promise<void>((done) =>
    child.on("exit", () => {
      done();
    }),
  );
});

/**
 * A beat as a daemon that died `agoMs` ago would have left it.
 *
 * `pid` is part of the fixture rather than a constant, because it is part of
 * what the cases are about: a beat carries the id of the process that wrote
 * it, and whether that process is still there is now half the answer. Every
 * case that models a LIVE daemon uses a live pid, and until B228 they all
 * used a pid nothing held — which is to say every "still running" case was
 * describing a dead daemon and asserting it read as alive.
 */
const beatWritten = (agoMs: number, pid: number = deadPid) =>
  writeHeartbeat(paths.heartbeat, {
    at: Date.now() - agoMs,
    pid,
  });

/** The same, from a process that is demonstrably alive: this one. */
const beatFromALiveProcess = (agoMs: number) => beatWritten(agoMs, process.pid);

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
    await beatFromALiveProcess(5_000);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
    expect(out).not.toContain("nothing has written");
    /* And it is not quietly complaining on the other stream while printing a
       calm headline — a status that errors is a status somebody scripted
       against and did not notice. */
    expect(errored).toBe("");
  });

  it("does not tell a never-run device its beat is zero seconds old", async () => {
    /**
     * Found by the linter while B228 was being written, which is the only
     * reason it was found: nothing asserted this sentence.
     *
     * The evidence line computed `now - (beat?.at ?? now)`, which is ZERO when
     * there is no beat — so a paired machine whose daemon has never run was
     * told "nothing has written this device's heartbeat for 0 seconds". The
     * verdict was right and its stated reason was not a sentence about
     * anything, on the screen whose whole job this release is to make
     * believable.
     */
    await paired();
    await status();

    expect(out).toContain("state: NOT RUNNING");
    expect(out).toContain("nothing has ever written");
    expect(out, "an age it does not have").not.toMatch(/for 0 second/);
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
    await beatFromALiveProcess(5_000);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
  });

  it("catches the daemon Todd stopped a moment ago — B228", async () => {
    /**
     * The row's own case, and the one the age arm cannot reach.
     *
     * Todd stopped his daemon and `byollm status` said `running`. The beat is
     * SECONDS old, so the staleness threshold says nothing; failures are zero
     * because it was working right up until he stopped it; supervision is
     * `absent` because it was a daemon in a terminal. Everything falls through
     * to `running` about a process that does not exist — for a full minute,
     * and the first thing somebody does after `byollm stop` is `byollm status`.
     *
     * The pid has been on the beat since B202 for exactly this, with a comment
     * saying so, and nothing asked it for three releases.
     */
    await beatWritten(5_000);
    await status();

    expect(out).toContain("state: NOT RUNNING");
  });

  it("gives that verdict the evidence that actually supports it", async () => {
    /**
     * The two arms have different working, and printing the wrong one is its
     * own defect: "nothing has written this heartbeat for 5 seconds" is not an
     * argument that anything is wrong, on the one screen that has to be
     * believed. The missing process is the argument, so the process is what it
     * names.
     */
    await beatWritten(5_000);
    await status();

    expect(out).toContain("is gone");
    expect(out).toContain(String(deadPid));
    expect(out, "the age is not the argument here").not.toContain(
      "nothing has written",
    );
  });

  it("still blames the age when the process is still there", async () => {
    /**
     * The control on the sentence above, and the distinction that makes both
     * sentences worth having: a beat twenty minutes old whose process is STILL
     * RUNNING is a wedged daemon, not a stopped one — and restarting is the
     * answer to one of those and not the other.
     */
    await beatFromALiveProcess(20 * 60_000);
    await status();

    expect(out).toContain("state: NOT RUNNING");
    expect(out).toContain("nothing has written");
    expect(out).not.toContain("is gone");
  });

  it("says the process is gone even when the beat is old too", async () => {
    /**
     * The commonest real shape — a daemon stopped this morning has both an old
     * beat and a pid nothing holds — and the case a mutation walked straight
     * through: my first version suppressed the process sentence whenever the
     * beat was also stale, on the theory that the age was the better thing to
     * say. It is not. "Stopped" and "wedged" are the two situations a reader
     * has to tell apart, and only this sentence tells them.
     */
    await beatWritten(20 * 60_000);
    await status();

    expect(out).toContain("state: NOT RUNNING");
    expect(out).toContain("is gone");
    /* And the sentence does not call a twenty-minute-old beat "only" that
       old. Matched on the clause rather than the word: `status` says "only"
       elsewhere for honest reasons, and a bare word match would have been
       asserting about two other lines. */
    expect(out).not.toContain("is gone, and the beat is only");
    expect(out).toContain("20 minutes old");
  });

  it("does not demote on a pid that is merely unreachable", async () => {
    /**
     * `kill(pid, 0)` throws `EPERM` for a process owned by somebody else — it
     * EXISTS. Reading that as death would call a healthy daemon dead whenever
     * `status` was run by a different user than the one running it, which is
     * the more expensive error.
     *
     * pid 1 is the case everywhere this runs: it exists, and it is not ours.
     */
    await beatWritten(5_000, 1);
    await status();

    expect(out).not.toContain("state: NOT RUNNING");
  });

  it("treats a pid that is not a process id as no evidence at all", async () => {
    /**
     * `process.kill(0, ...)` signals the whole process GROUP, and a negative
     * pid signals a group too. Neither is a question about this daemon, and
     * one of them is dangerous even with signal 0 — so a malformed pid must
     * fall back to the age rule rather than be asked.
     *
     * A fresh beat with such a pid is therefore a running daemon as far as
     * this surface knows, which is the honest answer to "we have no evidence".
     *
     * **Both spellings, because only one of them distinguishes the guard.**
     * Mutating the guard away and testing only `0` left the case green: `kill`
     * on group 0 succeeds, so the answer coincides. A NEGATIVE pid does not
     * coincide — group `99999` does not exist, `ESRCH` comes back, and without
     * the guard this surface would call a running daemon dead on the strength
     * of a group id it had no business asking about.
     */
    for (const pid of [0, -99_999]) {
      out = "";
      await beatWritten(5_000, pid);
      await status();

      expect(out, `pid ${String(pid)} was treated as evidence`).not.toContain(
        "state: NOT RUNNING",
      );
    }
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
    await beatFromALiveProcess(2_000);
    await status();

    expect(out).toContain("state: NOT REPORTING");
    expect(out).not.toContain("state: NOT RUNNING");
  });
});
