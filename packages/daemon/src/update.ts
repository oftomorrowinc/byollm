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
 * Drain, install, re-register, canary, and only then keep it. Each step
 * exists because skipping it breaks something specific:
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
 * - **Canary by identity, not liveness.** The check is "does the installed
 *   binary say it is the version we asked for", not "does it start". A
 *   half-finished install that leaves the old binary in place starts
 *   perfectly.
 * - **Rollback**, which is the same install run with the version we came
 *   from. Kept as a value rather than discovered later: after a bad install
 *   the machine can no longer be asked what it used to be.
 *
 * ## What it does when it cannot fix itself
 *
 * A failed rollback is not retried and not hidden. It reports, loudly, on
 * the owner's surfaces and stops — a loop here is a machine that reinstalls
 * npm packages forever, and the honest end state is a daemon that says what
 * happened and leaves the machine to a person.
 */

/** A version this updater is willing to install. */
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

export interface UpdateDeps {
  /** Finish the running job and claim nothing. Resolves when idle. */
  readonly drain: () => Promise<void>;
  /** `npm i -g byollm@<version>`. Resolves to whether it succeeded. */
  readonly install: (version: string) => Promise<boolean>;
  /** Re-register with the supervisor, since the entry point moved. */
  readonly reregister: () => Promise<boolean>;
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
): Promise<UpdateOutcome> {
  const target = exactVersion(to);
  if (target === undefined) {
    /* Before anything is drained. An update we would not finish must not
       cost somebody the jobs this machine was about to claim. */
    const why = `refusing to install "${to}" — the updater installs exact versions only`;
    deps.report(why);
    return { kind: "refused", why };
  }
  if (target === from) {
    return { kind: "refused", why: `already on ${from}` };
  }
  /* `from` has to be installable too, or the rollback is a promise we cannot
     keep. Better to decline the update than to take a machine somewhere it
     cannot come back from. */
  if (exactVersion(from) === undefined) {
    const why = `refusing to update from "${from}" — no version to roll back to`;
    deps.report(why);
    return { kind: "refused", why };
  }

  await deps.drain();

  if (!(await deps.install(target))) {
    /* Nothing was replaced, so there is nothing to undo — npm leaves the
       previous global in place when an install fails. Re-register anyway:
       the drain stopped this daemon claiming, and leaving it drained would
       be a machine that quietly serves nothing after a failed update. */
    await deps.reregister();
    const why = `could not install ${target} — staying on ${from}`;
    deps.report(why);
    return { kind: "refused", why };
  }

  await deps.reregister();

  const reported = await deps.installedVersion();
  if (reported === target) {
    return { kind: "updated", to: target };
  }

  /* The canary failed: either the binary does not answer, or it answers with
     a version nobody asked for. Both mean the machine is not running what we
     believe it is running, which is the state an updater exists to prevent. */
  const why =
    reported === undefined
      ? `${target} did not answer after installing`
      : `installed ${target} but the binary reports ${reported}`;

  if (!(await deps.install(from))) {
    const stranded = `${why}; rolling back to ${from} also failed`;
    deps.report(stranded);
    return { kind: "stranded", why: stranded };
  }
  await deps.reregister();

  const back = await deps.installedVersion();
  if (back !== from) {
    /* Rolled back and it did not take. Not retried — a loop here reinstalls
       forever — and said plainly, because a person has to look at this one. */
    const stranded = `${why}; rolled back to ${from} and the binary reports ${
      back ?? "nothing"
    }`;
    deps.report(stranded);
    return { kind: "stranded", why: stranded };
  }

  deps.report(`${why}; rolled back to ${from}`);
  return { kind: "rolled-back", to: from, why };
}
