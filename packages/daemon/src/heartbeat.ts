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
