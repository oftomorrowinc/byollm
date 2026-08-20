import { z } from "zod";
import {
  PublicIdentity,
  type StoredKeys,
  keyId,
  signWith,
  verifyPublicIdentity,
  verifyWith,
} from "./keys.js";

/**
 * Rotation — byollm_009 Amendment C.
 *
 * A site holding identity key **K1** wants to be known by **K2**. It publishes
 * a *succession*: K2, plus a signature by K1 over a statement naming both key
 * ids. That signature is the entire mechanism, and the reason rotation can be
 * automatic without becoming a hole is that **the relay cannot mint one** — it
 * never holds K1. It is the same trust step a daemon already performs at
 * pairing, applied to the site's own succession.
 *
 * ## Why the statement names both keys
 *
 * A signature over K2 alone could be lifted from this site's record and
 * replayed into another site's, moving *that* site to K2 — a key the attacker
 * holds. Naming the predecessor binds the succession to one chain, and it is
 * the reason `verifyLink` takes the id it expects to be succeeding from
 * rather than reading it out of the statement it is checking.
 */

/** The domain separator. Distinct from every other thing an identity signs. */
export const SUCCESSION_CONTEXT = "byollm/v1/site-succession";

/**
 * How long a retired key may still sign work — Amendment C, ruling 2.
 *
 * A protocol constant and not the site's to choose. Per-site overlap
 * arithmetic is exactly the kind of number that has to mean one thing
 * everywhere, and a site that could choose it could choose *forever*, which is
 * a two-key site permanently and a second key nobody ever notices retiring.
 *
 * Seven days: long enough that a daemon which polls daily and a laptop shut
 * for a long weekend both see the new record before the old key stops working,
 * short enough that "which key is live" is never an interesting question.
 */
export const RETIREMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest chain a daemon will walk — Amendment C, ruling 1.
 *
 * **A denial-of-service guard, not policy.** The bound exists so a projection
 * cannot make a daemon verify ten thousand signatures, not to express an
 * opinion about how often a site may rotate. A site that legitimately exceeds
 * it has a re-pair ahead of it, which is why it is generous: at one rotation a
 * quarter this is sixteen years.
 */
export const MAX_SUCCESSION_CHAIN = 64;

/** One step of a chain: a key, and the signature by it over its successor. */
export const Succession = z
  .object({
    /**
     * The predecessor's public identity — K1, in full.
     *
     * The whole identity rather than the key id, because a daemon meeting a
     * chain it has not seen before has to *verify* each link, and a key id is
     * a fingerprint: enough to compare, never enough to check a signature.
     */
    identity: PublicIdentity,
    /** K1's signature over the statement naming K1 and its successor. */
    signature: z.string().min(1),
  })
  .strict();
export type Succession = z.infer<typeof Succession>;

/** The exact bytes signed. One definition; both sides call it. */
export function successionStatement(
  fromKeyId: string,
  toKeyId: string,
): Uint8Array {
  return Buffer.from(`${SUCCESSION_CONTEXT}:${fromKeyId}:${toKeyId}`);
}

/**
 * Sign a succession from the keys being retired to the identity taking over.
 *
 * Takes `StoredKeys` for the predecessor because only the holder of K1's
 * private half can produce this, which is the property the whole design rests
 * on. A site calls this once, at rotation, on the machine holding its keys.
 */
export function signSuccession(
  previous: StoredKeys,
  next: PublicIdentity,
): Succession {
  return {
    identity: {
      identity: previous.identityPublic,
      encryption: previous.encryptionPublic,
      encryptionSig: previous.encryptionSig,
    },
    signature: signWith(
      previous,
      successionStatement(keyId(previous.identityPublic), keyId(next.identity)),
    ),
  };
}

/**
 * Check one link: did `link.identity` sign over succeeding to `toKeyId`?
 *
 * `toKeyId` is passed in rather than read from anywhere in `link`, and that is
 * the load-bearing detail. A verifier that recovered the successor from the
 * signed statement would accept a statement about *any* successor, which is
 * the replay this design names in C.1 — the signature is genuine, the
 * successor it names is not the one being installed.
 */
export function verifyLink(link: Succession, toKeyId: string): boolean {
  // The predecessor's own identity is checked first, for the reason
  // `verifyPublicIdentity` exists: an encryption key not signed by the
  // identity presenting it is an upstream substitution, and a chain is a
  // place that key would otherwise arrive unexamined.
  if (!verifyPublicIdentity(link.identity)) return false;
  return verifyWith(
    link.identity.identity,
    successionStatement(keyId(link.identity.identity), toKeyId),
    link.signature,
  );
}

/** Why a chain was refused, in the words a log line uses. */
export type SuccessionFailure =
  "no-chain" | "too-long" | "unknown-origin" | "broken-link";

export interface SuccessionWalk {
  /** The ids the chain passes through, oldest first, ending at the current. */
  readonly path: string[];
  /** The approved id the chain reached, when it reached one. */
  readonly from?: string;
  readonly failure?: SuccessionFailure;
}

/**
 * Walk a chain from the key being presented back to a key already approved.
 *
 * `chain` is ordered oldest last, as the projection carries it — so walking it
 * means starting at the current key and stepping backwards, each link proving
 * that its holder signed for the id in front of it.
 *
 * Returns the approved id it reached, or why it did not. **Deliberately
 * returns rather than throws**: a chain that does not verify is ordinary
 * hostile input, and the caller's job is to keep its existing pin and say so.
 *
 * `approved` is asked as a predicate rather than taken as a set because the
 * daemon's notion of "already approved" includes tombstoned ids — a site that
 * left the allowlist and came back is still a site this machine has vouched
 * for, and rotation must not become a way to launder that distinction away.
 */
export function walkSuccession(input: {
  current: string;
  chain: readonly Succession[];
  approved: (keyId: string) => boolean;
}): SuccessionWalk {
  const { current, chain, approved } = input;
  if (chain.length === 0) return { path: [current], failure: "no-chain" };
  if (chain.length > MAX_SUCCESSION_CHAIN)
    return { path: [current], failure: "too-long" };

  // Newest first: the last entry is the key that signed for `current`.
  const steps = [...chain].reverse();
  const path = [current];
  let succeeding = current;

  for (const link of steps) {
    if (!verifyLink(link, succeeding)) return { path, failure: "broken-link" };
    const previous = keyId(link.identity.identity);
    path.unshift(previous);
    if (approved(previous)) return { path, from: previous };
    succeeding = previous;
  }

  // Every link verified and none of them is a key this machine ever approved.
  // Not an attack and not an error: a stranger with a history, offered for
  // local approval like any other stranger.
  return { path, failure: "unknown-origin" };
}
