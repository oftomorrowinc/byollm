import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * How the daemon's conversation with its upstream is going — written by the
 * daemon, read by `byollm status`.
 *
 * The failure that produced this file: a device's every heartbeat was refused
 * for hours, once every ten seconds, and `byollm status` said `state:
 * running` throughout. That was true. The daemon was running. It was also
 * reporting nothing, invisible to the hub, and showing a card full of frozen
 * data — and the only surface that knew was a log line nobody tails.
 *
 * **A persistent rejection is a state, not a louder log.** One refusal is
 * noise: a rolling deploy, a dropped connection, a moment of unluck. Forty in
 * a row is a device that has stopped participating and does not know it, and
 * the difference between those is a count, which means somebody has to keep
 * one.
 */
export interface DaemonHealth {
  /** When this was written, epoch ms. */
  readonly at: number;
  /** Consecutive failed exchanges with the upstream. Zero after any success. */
  readonly consecutiveFailures: number;
  /** What the upstream last said, verbatim. */
  readonly lastError?: string;
  /** The origin it was talking to. */
  readonly origin?: string;
}

/**
 * Enough failures in a row to mean something.
 *
 * At a ten-second beat this is about a minute — long enough that a rolling
 * deploy or a flaky minute has passed, short enough that somebody typing
 * `byollm status` because "it isn't working" gets told why on the first try.
 */
export const FAILURES_BEFORE_ALARM = 6;

export async function writeHealth(
  path: string,
  health: DaemonHealth,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(health)}\n`, "utf8");
  } catch {
    // A daemon that cannot write its health file still has work to do. This
    // is a diagnostic, and a diagnostic that can stop the thing it describes
    // is worse than no diagnostic.
  }
}

/**
 * What the daemon last recorded, or `undefined` if it never has.
 *
 * Undefined is not "healthy" — it is "this daemon has not said", which is the
 * state of a machine whose daemon predates this file or has never started.
 * Callers must not collapse the two.
 */
export async function readHealth(
  path: string,
): Promise<DaemonHealth | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { consecutiveFailures?: unknown })
        .consecutiveFailures !== "number"
    ) {
      return undefined;
    }
    return parsed as DaemonHealth;
  } catch {
    return undefined;
  }
}
