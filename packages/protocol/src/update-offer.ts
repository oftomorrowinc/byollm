/**
 * Who may be told about a new version — B053.
 *
 * `HeartbeatResponse.updateTo` is a new field on a `.strict()` schema, and
 * strict means a daemon built before the field does not ignore it: it rejects
 * the entire heartbeat. Send it to everybody and the message carrying the
 * update is the message that takes offline the machines it was meant to
 * update — the fleet-wide version of the failure this codebase keeps meeting
 * one surface at a time.
 *
 * No handshake is needed to avoid that. `HeartbeatRequest.daemonVersion` is
 * already on the wire, so the sender can simply decline to say anything a
 * given listener cannot hear. The rule lives here, next to the field it
 * governs, because a rule of this kind in a runbook is a rule that holds
 * until the next person deploys.
 *
 * ## The other direction, deliberately not taken
 *
 * The tidier-looking design is a capability list on the request — the daemon
 * says what it understands. It has a hole this one does not: that field is
 * also new, the hub's schema is also strict, and an upgraded daemon sending
 * it to a hub that has not deployed yet is refused outright. It makes the
 * daemon's upgrade depend on the hub's, in a system where the daemon is the
 * side we do not control the timing of.
 *
 * Reading a field that already exists has no such ordering problem: old
 * daemons are never sent the new field, new daemons are, and neither needs
 * the other to have moved first.
 */

/**
 * The first daemon version whose schema has `updateTo` in it.
 *
 * Raising this is safe and lowering it is not, which is worth knowing before
 * anybody tidies it: too high means some daemons miss an update they could
 * have taken, and too low means their heartbeats are refused.
 */
export const UPDATE_OFFER_SINCE = "0.1.0-alpha.83";

/** A version split into the parts that order it. */
function parse(
  version: string,
):
  | { readonly release: number[]; readonly pre: (number | string)[] }
  | undefined {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (match === null) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre:
      match[4] === undefined
        ? []
        : match[4]
            .split(".")
            .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

/**
 * Semver ordering, only as far as this needs it.
 *
 * Numeric prerelease parts compare as numbers, which is the whole reason not
 * to compare these as strings: `alpha.9` sorts after `alpha.83`
 * lexicographically, and that mistake here means every daemon between .10 and
 * .82 is treated as too old to hear about an update — or worse, in the other
 * direction, sent a field it cannot parse.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  /* A release outranks any prerelease of the same numbers: 1.0.0 is newer
     than 1.0.0-alpha.1, and an empty prerelease list means release. */
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    /* Numeric identifiers always have lower precedence than alphanumeric
       ones, per semver — and mixing them at the same position is a shape we
       do not produce, so this only has to be defensible, not clever. */
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * May this daemon be told about a new version?
 *
 * **A version this cannot parse is a no.** Unreadable is not permission: the
 * consequence of guessing wrong in that direction is the daemon's heartbeat
 * being refused, which is worse than it missing one update cycle. The same
 * rule the rest of this protocol applies to unreadable answers, on the one
 * field where getting it wrong is fleet-shaped.
 */
export function mayOfferUpdate(daemonVersion: string): boolean {
  const order = compareVersions(daemonVersion, UPDATE_OFFER_SINCE);
  return order !== undefined && order >= 0;
}

/**
 * The oldest daemon a hub will serve — B052, the floor.
 *
 * The updater's backstop and its opposite number. The updater moves machines
 * that opted in; the floor is what moves the ones that did not, and it is the
 * only mechanism that works on a daemon which is not listening for offers.
 *
 * Raising it is a deliberate act with a spec note, never automatic — a floor
 * that followed `latest` would refuse every machine that had not updated in
 * the last hour, which is the outage version of hygiene.
 */
export interface FloorRefusal {
  readonly error: "daemon-below-floor";
  readonly message: string;
  readonly floor: string;
}

/**
 * Is this daemon too old to serve?
 *
 * **An unreadable version is NOT refused**, and that is the deliberate
 * asymmetry with {@link mayOfferUpdate}, which treats an unreadable version
 * as "do not offer". The two point the same way once you ask what the
 * mistake costs: there, guessing yes sends a field that breaks the
 * heartbeat; here, guessing yes takes a working machine out of service over
 * a string it could not parse. Both decline to act when they cannot tell,
 * and declining to act means opposite booleans.
 */
export function checkDaemonFloor(input: {
  readonly daemonVersion: string;
  readonly floor: string;
  /** How somebody fixes it. The floor is useless without the remedy. */
  readonly upgradeCommand: string;
}): FloorRefusal | null {
  const order = compareVersions(input.daemonVersion, input.floor);
  if (order === undefined || order >= 0) return null;
  return {
    error: "daemon-below-floor",
    message:
      `byollm ${input.daemonVersion} is below the supported floor ` +
      `(${input.floor}). Run \`${input.upgradeCommand}\`, then ` +
      "`byollm start`.",
    floor: input.floor,
  };
}
