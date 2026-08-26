import { Buffer } from "node:buffer";
import { z } from "zod";
import { signWith, verifyWith, type StoredKeys } from "./keys.js";

/**
 * The roster a daemon holds, and how it knows the roster is real.
 *
 * byollm_001 Amendment G, RATIFIED 2026-08-25. A `team` job is admitted by a
 * list **this device holds**, signed by the owner's control plane and verified
 * against a key pinned at pairing — never by an assertion from the party
 * routing the job, per-job or in bulk.
 *
 * The relay's power over this is exactly denial: it can withhold a roster as
 * it can withhold a job, and it can forge neither. That is what lets the hub
 * go on reading and filtering rosters for its own routing without being
 * trusted for admission — non-authorship, not blindness.
 */

/**
 * How old a held roster may be before a device stops honouring it.
 *
 * One hour, and the shortest constant in this protocol on purpose: every other
 * one bounds how long a *thing* stays valid, and this one alone bounds how
 * long a *person* keeps access after the owner has said no.
 *
 * A failure bound, not a sync interval. A daemon refreshes on every heartbeat
 * and a removal propagates in seconds; the hour is what a device gets when
 * that conversation stops working — enough that a closed laptop or a flaky
 * café network does not narrow a working device, and not so much that a
 * removed teammate outlives the owner's patience.
 */
export const ROSTER_MAX_AGE_MS = 60 * 60_000;

/**
 * The domain separator, and why a roster gets its own.
 *
 * Every signature in this system says what kind of statement it is before it
 * says anything else. Without that, bytes signed for one purpose verify for
 * another: a roster document and a request body are both "some bytes this key
 * signed", and a scheme that could not tell them apart would let a captured
 * roster be replayed as a request — or worse, let a control plane that signs
 * one thing be held to have signed the other.
 */
export const ROSTER_CONTEXT = "byollm/v1/roster";

export const SignedRoster = z
  .object({
    /** Whose devices this roster governs. */
    owner: z.string().min(1),
    /**
     * Who may have their `team` work run on this owner's devices.
     *
     * Owner ids, sorted, so the same membership always produces the same
     * bytes — a document that differed by iteration order would produce a new
     * signature every read and no way to tell a change from a shuffle.
     */
    members: z.array(z.string().min(1)),
    /**
     * When the control plane signed it — epoch ms, and the **only** honest
     * anchor for age.
     *
     * Not when the daemon received it. A relay that simply withholds updates
     * would otherwise keep a removed member served forever, which is the
     * attack {@link ROSTER_MAX_AGE_MS} exists to bound.
     */
    issuedAt: z.number().int().positive(),
    /** Base64url Ed25519 over {@link rosterStatement}. */
    signature: z.string().min(1),
  })
  .strict();
export type SignedRoster = z.infer<typeof SignedRoster>;

/**
 * The exact bytes both sides sign and verify.
 *
 * Every field that decides what the roster *means* is in here. Leave one out
 * and it becomes something an intermediary can change without breaking the
 * signature — `owner` most of all: a roster whose owner was not signed over
 * could be lifted from one account and delivered to another's devices, and
 * every signature check would pass.
 *
 * Members are joined with NUL, which cannot appear in an id, so no arrangement
 * of member names can imitate a different membership. Joining on a comma would
 * let `["a,b"]` and `["a","b"]` sign identically.
 */
export function rosterStatement(input: {
  owner: string;
  members: readonly string[];
  issuedAt: number;
}): Uint8Array {
  return Buffer.from(
    [
      ROSTER_CONTEXT,
      input.owner,
      String(input.issuedAt),
      [...input.members].sort().join("\0"),
    ].join("\n"),
    "utf8",
  );
}

/** Sign a roster with the control plane's own key. */
export function signRoster(
  keys: Pick<StoredKeys, "identityPrivate">,
  input: { owner: string; members: readonly string[]; issuedAt: number },
): SignedRoster {
  const members = [...input.members].sort();
  return {
    owner: input.owner,
    members,
    issuedAt: input.issuedAt,
    signature: signWith(keys, rosterStatement({ ...input, members })),
  };
}

/** Why a roster was refused. Typed for logs; never returned to a caller. */
export type RosterRefusal =
  "bad-signature" | "wrong-owner" | "stale" | "from-the-future";

/**
 * Is this roster one this device may admit people from, right now?
 *
 * `owner` is passed in rather than read out of the document, for the reason
 * {@link verifyLink} takes its successor as an argument: a verifier that
 * recovered the owner from the signed bytes would accept a genuine roster
 * belonging to somebody else, and every check would pass.
 *
 * Age is checked in **both** directions. A clock far ahead is as much a
 * problem as one behind: an `issuedAt` in the future would extend a roster's
 * life past the bound, which is the whole thing being enforced.
 */
export function verifyRoster(input: {
  roster: SignedRoster;
  owner: string;
  controlPlanePublic: string;
  now: number;
  maxAgeMs?: number;
}): RosterRefusal | null {
  const { roster, owner, now } = input;
  if (roster.owner !== owner) return "wrong-owner";

  const age = now - roster.issuedAt;
  if (age < 0) return "from-the-future";
  if (age > (input.maxAgeMs ?? ROSTER_MAX_AGE_MS)) return "stale";

  // Checked last, so a stale roster reports staleness rather than whichever
  // failure a verifier happened to test first — the same reason `verifyRequest`
  // checks freshness before the signature. "Your clock is wrong" and "this is
  // forged" send somebody to very different places.
  return verifyWith(
    input.controlPlanePublic,
    rosterStatement(roster),
    roster.signature,
  )
    ? null
    : "bad-signature";
}
