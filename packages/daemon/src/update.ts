/**
 * Updating byollm in place, and being able to take it back — B053.
 *
 * Ruled 2026-09-02 (016 §Auto-update): the supervisor is the home, there is
 * no second runner, and the daemon learns the version on a channel it already
 * polls. What that ruling stresses, and what this module is mostly made of,
 * is one sentence: **an updater must be able to un-update.**
 *
 * ## The order is the safety
 *
 * Drain, install, verify, canary, and only then re-register and keep it.
 * Each step exists because skipping it breaks something specific:
 *
 * - **Drain** — finish the running job, claim nothing new. `shutdown` was
 *   the nearest existing behaviour and it is the wrong one: it cancels the
 *   active jobs and releases the leases, so updating would mean killing work
 *   somebody was waiting on. An update is elective; a job is not.
 * - **Exact version, never a tag.** `npm i -g byollm@latest` inside an
 *   updater means the fleet installs whatever the tag points at by the time
 *   each machine gets around to it — different machines, different builds,
 *   one version number in the logs. {@link exactVersion} refuses anything
 *   that is not a literal version, and that refusal is the reason it exists.
 * - **Forward only** — B360. A version at or below the running one is
 *   refused, and so is a pair this cannot order. An offer is a claim about
 *   what is newer, and a downgrade is how a machine is walked back onto a
 *   release with a known hole in it.
 * - **Provenance before it runs** — B360. After npm installs and before
 *   anything starts the new binary, the package's SLSA provenance must say
 *   our release workflow built these exact bytes (`provenance.ts`). A
 *   package that fails is rolled back without ever having been executed.
 * - **Canary by identity, not liveness.** The check is "does the installed
 *   binary say it is the version we asked for", not "does it start". A
 *   half-finished install that leaves the old binary in place starts
 *   perfectly.
 * - **Rollback**, which is the same install run with the version we came
 *   from. Kept as a value rather than discovered later: after a bad install
 *   the machine can no longer be asked what it used to be.
 * - **Re-register last, and only on success** — #9572. Re-registering is
 *   `byollm start`, and on launchd `start` begins with a `bootout` of the
 *   job this daemon IS. Run from inside the daemon, that bootout killed the
 *   daemon and, with its process group, the `start` that was about to
 *   `bootstrap` it back: Todd's Mac on 11-18 took 0.1.5 and was left with no
 *   service and no daemon (launchd's own log: "booting out service: caller =
 *   launchctl<-node<-node[the daemon]", and no bootstrap after it). So it is
 *   the last step, after the canary, on the one path where the daemon exits
 *   anyway — and `start` itself now hands the work to a detached copy that
 *   waits for this process to exit (`cli.ts`, `handOffFromTheDaemon`). A
 *   failed install or a rollback re-registers nothing: the running daemon
 *   never stopped being the supervised one, and re-registering it from
 *   inside is the operation that takes it down.
 *
 * ## What it does when it cannot fix itself
 *
 * A failed rollback is not retried and not hidden. It reports, loudly, on
 * the owner's surfaces and stops — a loop here is a machine that reinstalls
 * npm packages forever, and the honest end state is a daemon that says what
 * happened and leaves the machine to a person.
 */

import { compareVersions } from "@byollm/protocol";
import type { Provenance } from "./provenance.js";

/** A version this updater is willing to install. */

/** What `byollm start`, run by the updater, did about the supervisor. */
type Reregistered = "registered" | "handed-off" | "failed";

/**
 * The words by which a handed-off `start` says so — #9572, #9594.
 *
 * Written by the `start` just INSTALLED and read by the updater of the
 * version being left, so it crosses versions: change it and every older
 * updater reads a hand-off as a registration. `cli.ts` prints it; the
 * hand-off tests in an-update-comes-back-up.test.ts read it back through the
 * real updater.
 */
export const HANDED_OFF_SAYS = "it finishes once that daemon exits";

export type ExactVersion = string & { readonly __exact: unique symbol };

/**
 * Accept only a literal version, never a tag or a range.
 *
 * `latest`, `^0.1.0` and `0.1.x` all name "whatever is current when this
 * runs", and an updater that accepts them cannot say what it installed. The
 * whole fleet asking for the same tag at different minutes is a fleet on
 * different builds reporting the same number.
 */
export function exactVersion(value: string): ExactVersion | undefined {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? (value as ExactVersion)
    : undefined;
}

/** What a drain left behind — #9594, for the line that says it happened. */
interface DrainTally {
  /** Jobs that were running when the drain began and finished inside it. */
  readonly finished: number;
  /** Jobs still running when the drain gave up waiting. */
  readonly stillRunning: number;
}

export interface UpdateDeps {
  /**
   * Finish the running job and claim nothing. Resolves when idle, saying how
   * many jobs it waited for — the step's line in the service log.
   */
  readonly drain: () => Promise<DrainTally>;
  /** `npm i -g byollm@<version>`. Resolves to whether it succeeded. */
  readonly install: (version: string) => Promise<boolean>;
  /**
   * Did our release workflow build what was just installed? — B360.
   *
   * Asked after the install and before {@link reregister}, which is the
   * first thing that would run the new binary.
   */
  readonly verify: (version: string) => Promise<Provenance>;
  /**
   * Re-register with the supervisor, since the unit may have moved.
   *
   * Called once, last, and only when the update is kept: the daemon exits
   * straight after. Never on a failure path — #9572.
   *
   * `handed-off` is a `start` that registered nothing yet: run by the daemon
   * it re-registers (launchd, Task Scheduler), it started a detached copy
   * that registers once this daemon exits — `cli.ts`, `handOffFromTheDaemon`.
   * The account must not say "re-registered" for it (Owl, #9594): the copy's
   * lines carry no "update:" prefix, so a hand-off that then fails would
   * leave an account ending on a success claim.
   */
  readonly reregister: () => Promise<Reregistered>;
  /**
   * What the installed binary says its version is.
   *
   * `undefined` when it could not be asked at all — which is a failure here,
   * not a third state: this runs immediately after an install, so "cannot
   * say" means the thing we just installed does not answer.
   */
  readonly installedVersion: () => Promise<string | undefined>;
  /** Said on the owner's surfaces. */
  readonly report: (line: string) => void;
}

export type UpdateOutcome =
  | { readonly kind: "updated"; readonly to: string }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "rolled-back"; readonly to: string; readonly why: string }
  | { readonly kind: "stranded"; readonly why: string };

/**
 * Move this machine to `to`, or put it back the way it was.
 *
 * `from` is passed in rather than read here on purpose: it is the value the
 * rollback needs, and after a bad install the machine can no longer be asked
 * what it used to be.
 */
export async function update(
  from: string,
  to: string,
  deps: UpdateDeps,
  /** Which origin made the offer, for the first line of the account. */
  offeredBy?: string,
): Promise<UpdateOutcome> {
  const target = exactVersion(to);
  if (target === undefined) {
    /* Before anything is drained. An update we would not finish must not
       cost somebody the jobs this machine was about to claim. */
    const why = `refusing to install "${to}" — the updater installs exact versions only`;
    deps.report(why);
    return { kind: "refused", why };
  }
  /* `from` has to be installable too, or the rollback is a promise we cannot
     keep. Better to decline the update than to take a machine somewhere it
     cannot come back from. */
  if (exactVersion(from) === undefined) {
    const why = `refusing to update from "${from}" — no version to roll back to`;
    deps.report(why);
    return { kind: "refused", why };
  }
  /* Forward only — B360. Both sides are exact by now, so `undefined` should
     not happen; it is refused anyway, because "cannot tell which is newer"
     is not permission to install. */
  const order = compareVersions(target, from);
  if (order === 0) {
    return { kind: "refused", why: `already on ${from}` };
  }
  if (order === undefined || order < 0) {
    const why =
      order === undefined
        ? `refusing to install ${target} — cannot tell whether it is newer than ${from}`
        : `refusing to install ${target} — it is older than ${from}, and the updater never downgrades`;
    deps.report(why);
    return { kind: "refused", why };
  }

  /* From here every step says it happened — #9594. On 11-18 two Macs took
     0.1.5 and ended with no daemon, and `grep update ~/.byollm/service.log`
     on the Mac Studio found nothing: this reported only its failures, so the
     one event that had just changed the machine left no account of itself.
     An update is rare, so a line per step is cheap, and the line nobody
     wrote is the one somebody needs. */
  const now = Date.now;
  deps.report(
    `offer of ${target} taken${offeredBy === undefined ? "" : ` from ${offeredBy}`}, while running ${from}`,
  );

  const drainStarted = now();
  const tally = await deps.drain();
  deps.report(`drained in ${took(now() - drainStarted)} — ${counted(tally)}`);

  const installStarted = now();
  if (!(await deps.install(target))) {
    /* Nothing was replaced, so there is nothing to undo — npm leaves the
       previous global in place when an install fails. No re-register: this
       once ran one "because the drain stopped this daemon claiming", but the
       caller resumes claiming on every outcome but `updated`, and on launchd
       a re-register from inside the daemon is a bootout of the daemon
       (#9572). The supervised process never changed; leave it serving. */
    const why = `could not install ${target} — staying on ${from}`;
    deps.report(
      `${why}: npm left ${from} in place after ${took(now() - installStarted)}, ` +
        `so nothing needs rolling back, and this daemon goes back to work`,
    );
    return { kind: "refused", why };
  }
  deps.report(`installed ${target} in ${took(now() - installStarted)}`);

  /* Before the canary, because that is what first runs the new binary.
     A package nobody can vouch for goes back out without having executed —
     the install itself runs no scripts (`update-deps.ts`). */
  const proof = await deps.verify(target);
  if (!proof.verified) {
    return rollBack(
      from,
      `${target} failed its provenance check: ${proof.why}`,
      deps,
    );
  }
  deps.report(`provenance verified: our release workflow built ${target}`);

  /* The canary before the re-register, not after it — #9572. Asking the
     installed binary its version needs no supervisor, and re-registering
     is the one step the daemon cannot come back from in-process: it is
     only taken once the daemon is committed to exiting. */
  const reported = await deps.installedVersion();
  if (reported === target) {
    deps.report(
      `the installed binary says ${target}; re-registering with the supervisor (byollm start)`,
    );
    const registered = await deps.reregister();
    deps.report(
      registered === "registered"
        ? `re-registered; ${target} is kept and this daemon exits so the supervisor starts it`
        : registered === "handed-off"
          ? `byollm start handed the re-register to a copy that finishes after this ` +
            `daemon exits (its lines follow in this log, without "update:"); ` +
            `${target} is kept and this daemon exits — if no "update: now running" ` +
            `line follows, run \`byollm start\``
          : `re-registering did not succeed (its words are above); ${target} is ` +
            `installed and kept, and this daemon exits so the supervisor starts it — ` +
            `if \`byollm status\` says nothing is running, run \`byollm start\``,
    );
    return { kind: "updated", to: target };
  }

  /* The canary failed: either the binary does not answer, or it answers with
     a version nobody asked for. Both mean the machine is not running what we
     believe it is running, which is the state an updater exists to prevent. */
  return rollBack(
    from,
    reported === undefined
      ? `${target} did not answer after installing`
      : `installed ${target} but the binary reports ${reported}`,
    deps,
  );
}

/**
 * Put `from` back, once, and say how that went.
 *
 * No re-register — #9572. Nothing was registered with the version being
 * rolled back (that happens only after a passing canary), so the supervisor
 * still holds the unit it held before, which names the same entry point
 * `from` is now back at. The daemon running this is that unit's process.
 */
async function rollBack(
  from: string,
  why: string,
  deps: UpdateDeps,
): Promise<UpdateOutcome> {
  deps.report(`${why}; rolling back to ${from}`);
  if (!(await deps.install(from))) {
    const stranded = `${why}; rolling back to ${from} also failed`;
    deps.report(`${stranded}${strandedRemedy(from)}`);
    return { kind: "stranded", why: stranded };
  }

  const back = await deps.installedVersion();
  if (back !== from) {
    /* Rolled back and it did not take. Not retried — a loop here reinstalls
       forever — and said plainly, because a person has to look at this one. */
    const stranded = `${why}; rolled back to ${from} and the binary reports ${
      back ?? "nothing"
    }`;
    deps.report(`${stranded}${strandedRemedy(from)}`);
    return { kind: "stranded", why: stranded };
  }

  deps.report(
    `${why}; rolled back to ${from}, which the installed binary confirms — ` +
      `this daemon goes back to work on it`,
  );
  return { kind: "rolled-back", to: from, why };
}

/**
 * What a stranded machine's owner should run — #9594.
 *
 * The daemon writing this is still the old version in memory and goes on
 * serving, but whatever is on disk is neither version for certain, and the
 * next restart starts it. These two commands put back the version that was
 * running and re-register it, from a terminal, where a person can see npm's
 * own answer.
 */
function strandedRemedy(from: string): string {
  return (
    ` — this machine is stranded: what is installed is not a version this ` +
    `daemon could confirm. Run \`npm install --global byollm@${from}\` and then \`byollm start\``
  );
}

/** `0.4 s`, `12 s`, `3 min 5 s` — a step's length, in the service log. */
function took(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 120) return `${String(Math.round(s))} s`;
  const whole = Math.round(s);
  return `${String(Math.floor(whole / 60))} min ${String(whole % 60)} s`;
}

/** How many jobs a drain waited for, in words. */
function counted(tally: DrainTally): string {
  const jobs = (n: number) => `${String(n)} job${n === 1 ? "" : "s"}`;
  if (tally.finished === 0 && tally.stillRunning === 0) {
    return "nothing was running";
  }
  return [
    ...(tally.finished > 0 ? [`${jobs(tally.finished)} finished`] : []),
    ...(tally.stillRunning > 0
      ? [`${jobs(tally.stillRunning)} still running when the wait ran out`]
      : []),
  ].join(", ");
}

/**
 * Which offers reach the updater at all — B360.
 *
 * Every paired origin's heartbeat can carry `updateTo`, and until this the
 * newest one won whichever site named it: any site somebody paired with could
 * tell their machine what to install. Now exactly one origin may — the update
 * authority, `updateAuthority` in the config, the reference hub when unset —
 * and only over a pairing that pinned a control-plane key. A direct-mode
 * pairing has none: it is one site, and one site does not get to move the
 * daemon every other site is also talking to.
 *
 * A refused offer is said once per origin, not once per heartbeat: the offer
 * repeats until something takes it, and a line every ten seconds is a line
 * nobody reads.
 */
export function offerInbox(input: {
  /** Normalised, as the pairing origins are. */
  readonly authority: string;
  /** Whether this origin's pairing pinned a control-plane key. */
  readonly hasControlPlane: (origin: string) => boolean;
  readonly report: (line: string) => void;
}): {
  readonly receive: (origin: string, version: string) => void;
  readonly current: () => string | undefined;
  /** Who made {@link current}'s offer — the authority, by construction. */
  readonly origin: () => string | undefined;
} {
  let offered: string | undefined;
  let offeredBy: string | undefined;
  const refused = new Set<string>();
  return {
    receive: (origin, version) => {
      const why =
        origin !== input.authority
          ? `updates are taken only from ${input.authority}`
          : input.hasControlPlane(origin)
            ? undefined
            : "it is a direct-mode pairing, and those never update this daemon";
      if (why === undefined) {
        /* The newest offer wins, among the authority's own. `??=` here once
           held the FIRST offer forever, so a machine that rolled back never
           updated again until restarted (B053); the watcher refuses to retry
           a version it has already tried, which is what makes this safe. */
        offered = version;
        offeredBy = origin;
        return;
      }
      if (refused.has(origin)) return;
      refused.add(origin);
      input.report(`ignoring an offer of ${version} from ${origin} — ${why}`);
    },
    current: () => offered,
    origin: () => offeredBy,
  };
}
