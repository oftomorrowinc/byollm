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

/**
 * What happens after the remedy, which nobody was told — ruled 2026-09-03.
 *
 * `connect` said "paired" and the machine stayed dark, so the remedy looked
 * like it had failed. Two different things carry it back, and both are
 * automatic: a parked daemon polls the mark and promotes itself, and a daemon
 * that is not up is restarted by a supervisor holding `KeepAlive` — so the
 * one instruction that used to follow this line, `byollm install`, was work
 * nobody needed to do.
 *
 * Said out loud because a person who sees nothing happen reaches for the
 * reinstall on their own. The wait is bounded and short; the sentence is
 * here so the waiting is expected rather than alarming.
 */
export const REVOKED_RETURN =
  "the installed service returns by itself once you do — no reinstall";

/**
 * The remedy line, in the shape the CLI prints elsewhere.
 *
 * `returnsByItself` is asked rather than assumed, because the promise is only
 * true where something is holding the daemon up. A person running `byollm
 * run` in their own terminal has no service to come back on its own, and
 * telling them one exists would send them looking for a machine that is never
 * going to light up. **A promise belongs to the party that can keep it.**
 */
export function revokedRemedy(origin?: string, returnsByItself = true): string {
  return (
    `  re-pair:  byollm connect${origin === undefined ? "" : ` ${origin}`}\n` +
    (returnsByItself
      ? `  ${REVOKED_RETURN}.\n`
      : /* The restart step, on the one branch that needs one — rider closed
           2026-09-04.
 
           The original rider asked for `byollm install` back in the remedy.
           It is not the answer: a supervised daemon polls its mark and
           promotes itself, and a reinstall was work nobody needed to do. But
           the branch where nothing self-returns was left with a re-pair step
           and no next step at all — somebody running the daemon in their own
           terminal, whose process has already exited by the time they read
           this. Their restart is the command they typed, not an install. */
        `  then:     byollm run\n`)
  );
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
