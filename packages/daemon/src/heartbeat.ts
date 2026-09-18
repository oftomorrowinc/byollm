import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Is this daemon alive right now — B202.
 *
 * **Separate from `health.json`, and the split is the point.** Health is
 * persist-on-CHANGE: failures, sign-outs, quota blocks, revocation — the
 * things an owner must still be able to read hours later, and which a healthy
 * daemon must not rewrite every ten seconds to say nothing changed. Its own
 * comment says so at `runner.ts:2368`.
 *
 * That made it useless for liveness, and B201's first attempt read it as a
 * per-beat stamp anyway. Two ways wrong at once: a device whose file was
 * absent stayed "running", and a daemon that failed once and recovered froze
 * `at` at the recovery and read "NOT RUNNING" a minute later while serving
 * perfectly.
 *
 * So liveness gets its own file with its own cadence. **Written every beat,
 * overwriting a single small record** — never appended, so it cannot grow and
 * needs no rotation, which is what makes a per-beat write affordable at all.
 *
 * Not a box thing: `byollm run` on a laptop has exactly the same gap, and a
 * fix that lived in the box image would be a fork of the daemon.
 */
export interface DaemonHeartbeat {
  /** When this beat was written, epoch ms. */
  readonly at: number;
  /** The process that wrote it, so a reader can check it is still there. */
  readonly pid: number;
}

/**
 * Write the beat, atomically.
 *
 * Temp-and-rename because a reader can arrive mid-write: `rename` within a
 * directory is atomic, so `status` sees either the previous beat or this one
 * and never a half-written line it would report as corrupt.
 *
 * **The temp name is unique per write, and a test found out why.** With a
 * fixed `.writing` suffix two overlapping writes share a file: the second
 * truncates what the first is renaming, one `rename` fails, the error is
 * swallowed by design, and the beat silently stays at the older value. Beats
 * are ten seconds apart so production would not have met it for a long time —
 * which is exactly the kind of latency a race takes before it appears.
 *
 * Silent on failure, like `writeHealth`: a daemon that cannot write its
 * heartbeat still has work to do, and a diagnostic that can stop the thing it
 * describes is worse than no diagnostic.
 */
export async function writeHeartbeat(
  path: string,
  beat: DaemonHeartbeat,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(temp, `${JSON.stringify(beat)}\n`, "utf8");
    await rename(temp, path);
  } catch {
    // See above: this is a diagnostic, not the work.
  }
}

/** The last beat, or nothing — absent, unreadable and malformed are one answer. */
export async function readHeartbeat(
  path: string,
): Promise<DaemonHeartbeat | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { at?: unknown }).at === "number" &&
      typeof (parsed as { pid?: unknown }).pid === "number"
    ) {
      return parsed as DaemonHeartbeat;
    }
    return undefined;
  } catch {
    /* Absent is the common case and not an error: a daemon that has never run
       on this machine has never written one. The caller decides what that
       means, because "never started" and "stopped" are different facts and
       only the caller knows whether this device is meant to be serving. */
    return undefined;
  }
}

/**
 * Is the process that wrote this beat definitely gone — B228.
 *
 * `pid` has been on this record since B202 with a comment saying what it is
 * for — *"so a reader can check it is still there"* — and for three releases
 * nothing checked it. `status` read the beat's AGE and nothing else, which
 * leaves a window: a daemon killed five seconds ago has a fresh file, so the
 * age arm says nothing, `consecutiveFailures` is zero because it was working
 * when it died, `supervision.state` is `absent` for a daemon run in a
 * terminal, and the headline falls through to **`running` for a process that
 * does not exist.** That is a full minute of lying, and it is precisely the
 * minute in which somebody who just typed `byollm stop` types `byollm status`.
 *
 * ## It may demote, and it may never promote
 *
 * The asymmetry is the whole design, and getting it backwards is the classic
 * pidfile bug.
 *
 * **`ESRCH` is proof of death.** No process holds that id, so the writer is
 * gone, and nothing else has to be true for that to hold.
 *
 * **Success is not proof of life.** A pid is reused: the daemon's id can be
 * handed to something unrelated between its death and this read, and
 * `kill(pid, 0)` would then succeed about a process that has nothing to do
 * with byollm. So a successful signal returns `false` — *"not proven gone"* —
 * and the age rule still decides. This function can only ever move the answer
 * toward NOT RUNNING, never toward running, which means pid reuse costs a
 * missed demotion rather than a false reassurance.
 *
 * **`EPERM` is not death either.** Something exists under that id and belongs
 * to another user — evidence the id has been reused, but not evidence about
 * our daemon. Treated as "not proven gone" for the same reason.
 *
 * ## Where it is wrong, said out loud
 *
 * A pid only means something inside the namespace that issued it. If `status`
 * ever ran outside the daemon's namespace — a different container to the one
 * the daemon runs in — every pid would read `ESRCH` and this would demote a
 * healthy device. That is not today's shape (on a box the supervisor and the
 * daemon share a container, and on a laptop there is one namespace), and the
 * caller prints its evidence so a reader meeting that case can see the
 * reasoning rather than just the verdict.
 */
export function beatWriterIsGone(beat: DaemonHeartbeat): boolean {
  /* `process.kill(0, ...)` signals the whole process group and a negative pid
     signals a group too. Neither is a question about this daemon, and one of
     them is dangerous even with signal 0, so a pid that is not a plain process
     id is simply not evidence. */
  if (!Number.isInteger(beat.pid) || beat.pid <= 0) return false;
  try {
    process.kill(beat.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
