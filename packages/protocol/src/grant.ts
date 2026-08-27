import { Buffer } from "node:buffer";
import { z } from "zod";
import { signWith, verifyWith, type StoredKeys } from "./keys.js";

/**
 * One job, one signature, one answer — byollm_016 Amendment J.
 *
 * A grant is the control plane's signed statement that a particular job may
 * run on a particular device, authored at claim time and verified against the
 * key that device pinned when it paired.
 *
 * ## What it replaced, and why the replacement is smaller
 *
 * Until 2026-08-26 a device held a signed **roster** and answered admission
 * from it. Amendment G's four properties were right and the mechanism was a
 * cache — one that bought nothing. On the cloud route the job path and the
 * roster path share fate: jobs arrive through the relay, so if the relay is
 * unreachable there are no jobs to admit and a locally held roster adds no
 * availability. What it did add was staleness, which is the only reason
 * `ROSTER_MAX_AGE_MS` existed: a bound on how long a removed person keeps
 * running. Authoring at claim collapses that bound to this document's own
 * lifetime — add somebody and their next job runs, remove them and their next
 * claim fails, including jobs already queued.
 *
 * It also collapses four questions into one signature. Consented, member,
 * admitted, and *which service* were four mechanisms answering separately;
 * they are now four fields of one statement, and the device verifies once.
 *
 * ## What it is not
 *
 * Amendment G property 1 outlawed admitting on a per-job assertion, and this
 * is per-job. The distinction is authorship: G outlawed trusting the
 * **relay's or site's unsigned** claim. A grant is signed by the control
 * plane with a key the device pinned at pairing, so the relay can withhold it
 * and cannot forge it — exactly the power a relay has over a job.
 * `RELAY_BLIND` is untouched: the relay delivers, it never authors.
 *
 * ## What the device still checks for itself
 *
 * A grant is necessary and not sufficient. Four checks stay on the device and
 * none of them is delegated:
 *
 * 1. the signature, against the pinned key;
 * 2. replay — {@link SignedGrant.grantId} is single-use;
 * 3. offer-consistency — the named service is one this device actually
 *    offers, at a scope that includes this user;
 * 4. **private is absolute** — a `private` service runs for the paired owner
 *    and nobody else, so no compromise of a control plane can grant somebody
 *    else's job onto it.
 */

/**
 * How long a grant is honoured after it was signed. Ruled 120s (2026-08-26).
 *
 * This bounds **acceptance**, not execution: a job admitted inside the window
 * runs to completion however long it takes. So the number only has to cover
 * the trip from the control plane signing to the device checking — claim,
 * deliver, verify — and every second past that is a second a captured grant
 * stays useful.
 *
 * Two minutes is generous for that trip and mean for the capture. It is also
 * the number ordinary clock drift is measured against, which is why
 * {@link CLOCK_SKEW_WARN_MS} sits well inside it: a device whose clock is off
 * by half the window would refuse real work, and must be told before it does.
 *
 * The verifier's policy, deliberately not a field on the document. An
 * `expiresAt` the signer chose would let whoever signs decide how long their
 * own statement stays good, and the party with the most reason to want a
 * longer window is the party being bounded.
 */
export const GRANT_MAX_AGE_MS = 120_000;

/**
 * Clock disagreement past which a device says so, before it starts refusing.
 *
 * Skew eats {@link GRANT_MAX_AGE_MS} directly — a device 60s behind its
 * relay's clock has half a window left, and one 120s behind has none and
 * refuses everything for a reason no refusal message would otherwise name.
 * Thirty seconds is a quarter of the window: far enough out to be a real
 * problem, early enough to be a warning rather than an outage.
 */
export const CLOCK_SKEW_WARN_MS = 30_000;

/**
 * Skew past which a freshness refusal names the clock instead of the grant.
 *
 * Five seconds, because below that the clock is not the story and saying so
 * would send somebody to check ntp about an unrelated failure. Above it, "this
 * grant expired" and "your clock is wrong" are the same event wearing
 * different words, and only one of them can be acted on.
 */
export const CLOCK_ATTRIBUTION_MS = 5_000;

/**
 * The domain separator.
 *
 * Every signature in this system says what kind of statement it is before it
 * says anything else. Without it, bytes signed for one purpose verify for
 * another — a grant and a request are both "bytes this key signed", and a
 * scheme that could not tell them apart would let one be replayed as the
 * other.
 */
export const GRANT_CONTEXT = "byollm/v1/grant";

export const SignedGrant = z
  .object({
    /**
     * This grant's own id — what makes it single-use.
     *
     * **Not the job id, and the difference is load-bearing.** Binding
     * single-use to `jobId` would refuse a legitimate retry: a claim that
     * times out is re-claimed, the control plane authors a second grant for
     * the same job, and a device that recorded the job id as spent would
     * reject its own recovery. A fresh id per authorship replays nothing and
     * retries fine.
     */
    grantId: z.string().min(1),
    /**
     * The job this grant admits, and only this one.
     *
     * A grant lifted from one job and presented for another is the obvious
     * attack, and this field is why it fails.
     */
    jobId: z.string().min(1),
    /**
     * The site the work came from, **as a key id** — byollm-review 2026-08-27.
     *
     * This was `siteId`, holding the site's id in the control plane's
     * namespace, and it was signed by the engine and read by nobody. A signed
     * field nobody checks is not a weak guarantee, it is the appearance of
     * one: the design says "the grant carries the site", and nothing anywhere
     * compared it to anything.
     *
     * It could not be compared. Job ids are chosen per site, so a grant
     * authored for (site A, `job_1`) satisfied every device check against a
     * stub naming (site B, `job_1`) — but the device holds sites only by the
     * key ids it pinned, and had no way to relate a control-plane uuid to
     * one. Checking the field would have meant a lookup through the party the
     * grant exists to distrust.
     *
     * So the namespace changes to the one the device already has, and the
     * name changes with it: this is the same value as {@link JobStub.site},
     * compared directly, no lookup and nothing to believe. The control-plane
     * id is not carried alongside — it had no reader, and keeping an
     * unchecked field beside a checked one is how this hole was dug.
     */
    site: z.string().min(1),
    /** Whose job it is — the person the site enqueued for. */
    user: z.string().min(1),
    /**
     * Whose device it is for.
     *
     * Passed to {@link verifyGrant} rather than read out of the document, for
     * the reason every verifier here takes its subject as an argument: a
     * verifier that recovered the owner from the signed bytes would accept a
     * genuine grant belonging to somebody else and pass every check.
     */
    owner: z.string().min(1),
    /** The site purpose this job serves — byollm_016 Amendment L. */
    purpose: z.string().min(1),
    /** The kind of work. */
    kind: z.string().min(1),
    /**
     * The service the control plane resolved this (purpose, kind) to, from
     * the user's own mapping.
     *
     * Selection is the control plane's; **offer-consistency is the
     * device's**. A device verifies it actually offers this service, at a
     * scope that includes {@link user}, before running anything.
     */
    service: z.string().min(1),
    /** When the control plane signed it — epoch ms, the only anchor for age. */
    issuedAt: z.number().int().positive(),
    /** Base64url Ed25519 over {@link grantStatement}. */
    signature: z.string().min(1),
  })
  .strict();
export type SignedGrant = z.infer<typeof SignedGrant>;

/** Everything a grant says, before it is signed. */
export type GrantClaims = Omit<SignedGrant, "signature">;

/**
 * Every field of {@link SignedGrant} except the signature, sorted.
 *
 * **Derived from the schema, never written out by hand.** The unsigned-field
 * attack is that somebody adds a field to the document, forgets to add it to
 * the bytes, and ships a value an intermediary can rewrite without breaking
 * any signature. A hand-maintained list is exactly the shape that fails: it
 * does not grow when the code does, and nothing about adding a field reminds
 * you it exists.
 *
 * Reading the shape closes it structurally rather than by review. A new field
 * is signed the moment it is declared, and grant.test.ts asserts this list
 * still covers the schema so a future zod version that hides `shape` fails
 * loudly instead of silently signing less.
 */
export const GRANT_SIGNED_FIELDS: readonly (keyof GrantClaims)[] =
  Object.freeze(
    Object.keys(SignedGrant.shape)
      .filter((key) => key !== "signature")
      .sort(),
  ) as readonly (keyof GrantClaims)[];

/**
 * The exact bytes both sides sign and verify.
 *
 * JSON-encoded rather than joined with a separator, because a separator can
 * be imitated. Newline-joining `["a", "b\nc"]` and `["a\nb", "c"]` produces
 * identical bytes, so two different grants would share a signature — and the
 * values here include a site id and a user id, at least one of which comes
 * from somebody else's namespace. JSON escapes the separator it uses, so no
 * arrangement of field values can spell a different document.
 *
 * The context string leads, and the field order is the schema's own sorted
 * keys, so the encoding is canonical without anyone maintaining a list.
 */
export function grantStatement(claims: GrantClaims): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      GRANT_CONTEXT,
      ...GRANT_SIGNED_FIELDS.map((field) => claims[field]),
    ]),
    "utf8",
  );
}

/** Sign a grant with the control plane's own key. */
export function signGrant(
  keys: Pick<StoredKeys, "identityPrivate">,
  claims: GrantClaims,
): SignedGrant {
  return { ...claims, signature: signWith(keys, grantStatement(claims)) };
}

/**
 * Why a grant was refused.
 *
 * Split by remedy, because these send somebody to different places: fix your
 * clock, take it up with the relay, or nothing at all — you are being
 * attacked and the refusal worked.
 *
 * There is deliberately no `no-pinned-key` here. A device that pinned no
 * control-plane key never reaches this function: it is in direct mode, and
 * the question "is this grant good" does not arise. A value nothing can
 * return is a branch every caller has to handle and no test can reach.
 */
export type GrantRefusal =
  /** The signature does not verify against the pinned key. */
  | "bad-signature"
  /** Genuine, and for a different device's owner. */
  | "wrong-owner"
  /** Genuine, and lifted from a different job. */
  | "wrong-job"
  /** Older than {@link GRANT_MAX_AGE_MS}. */
  | "expired"
  /**
   * Issued in the future.
   *
   * Checked, and not as pedantry: an `issuedAt` ahead of now extends a
   * grant's life past the bound, which is the whole thing being enforced.
   */
  | "from-the-future";

/**
 * Is this grant one this device may act on, right now?
 *
 * Document-level checks only. Replay, offer-consistency and the private rule
 * need state this function does not have and are the device's to apply — see
 * the class comment for the full list of four.
 */
export function verifyGrant(input: {
  grant: SignedGrant;
  owner: string;
  jobId: string;
  controlPlanePublic: string;
  now: number;
  maxAgeMs?: number;
}): GrantRefusal | null {
  const { grant, now } = input;
  if (grant.owner !== input.owner) return "wrong-owner";
  if (grant.jobId !== input.jobId) return "wrong-job";

  const age = now - grant.issuedAt;
  if (age < 0) return "from-the-future";
  if (age > (input.maxAgeMs ?? GRANT_MAX_AGE_MS)) return "expired";

  // Checked last, so an expired grant reports expiry rather than whichever
  // failure a verifier happened to test first — the same ordering
  // `verifyRequest` uses. "Your clock is wrong" and "this is forged" send
  // somebody to very different places, and only one of them is actionable.
  return verifyWith(
    input.controlPlanePublic,
    grantStatement(grant),
    grant.signature,
  )
    ? null
    : "bad-signature";
}
