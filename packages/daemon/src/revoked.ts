import { readHealth, writeHealth } from "./health.js";

/**
 * What a revoked device says, and where the person is sent — ruled
 * 2026-09-03.
 *
 * One definition, because three surfaces print it and they disagreed once
 * already. Todd revoked a machine and then asked three of them what was
 * wrong: `status` said "state: running" above "service: NOT running",
 * `install` said "retry: byollm install", and the service log said "No apps
 * are paired yet". Three answers, none of them revoked, and one of them
 * actively wrong — retrying an install cannot fix a revocation.
 *
 * **A remedy must match the cause.** Re-pairing is the fix, so re-pairing is
 * what every one of these says.
 */
export const REVOKED_SENTENCE = "this device was revoked — re-pair to return";

/** The remedy line, in the shape the CLI prints elsewhere. */
export function revokedRemedy(origin?: string): string {
  return `  re-pair:  byollm connect${origin === undefined ? "" : ` ${origin}`}\n`;
}

/**
 * Was this device revoked, according to the last daemon that ran?
 *
 * Read from the health file rather than from the pairing, and that is
 * deliberate: the pairing may be absent for reasons that have nothing to do
 * with revocation, and the exit path has to tell those apart —
 * empty-because-revoked and empty-because-never-paired are different facts
 * with different remedies.
 *
 * `undefined` means "no daemon has said", which is not the same as "not
 * revoked" and is exactly what a machine looks like before its first run. The
 * callers here can treat it as not-revoked, because every one of them is
 * answering "should I say the revoked sentence" and the honest answer with no
 * evidence is no.
 */
export async function revokedMark(
  healthPath: string,
): Promise<{ at: number; origin: string } | undefined> {
  return (await readHealth(healthPath))?.revoked;
}

/**
 * Forget the mark, because the thing it names has been fixed.
 *
 * Called when a pairing succeeds. Re-pairing is the remedy this whole file
 * points at, so a mark that survived it would leave every surface saying
 * "revoked — re-pair to return" to somebody who just did.
 *
 * Reads and rewrites rather than deleting the file: the rest of the record is
 * the daemon's account of its upstream and is nobody's to throw away here.
 * Absent or unreadable is nothing to clear, which is the ordinary case on a
 * machine that has never been revoked.
 */
export async function clearRevokedMark(healthPath: string): Promise<void> {
  const health = await readHealth(healthPath);
  if (health?.revoked === undefined) return;
  const { revoked: _gone, ...rest } = health;
  await writeHealth(healthPath, rest);
}
