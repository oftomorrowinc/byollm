import { createHash } from "node:crypto";
import { z } from "zod";
import { signWith, verifyWith, type StoredKeys } from "./keys.js";

/**
 * Request signing — byollm_009 §4.2.
 *
 * Every authenticated call is signed by the calling device's identity key.
 * There is no bearer token on the daemon plane: possession of a file no
 * longer grants access, possession of a *key* does, and the key never leaves
 * the machine.
 *
 * ## Why this is not the server-issued nonce the spec first described
 *
 * byollm_009 §4.2 says "the upstream issues a nonce; the daemon signs it".
 * Implementing that costs one of two things: a round trip before every
 * request, or server-side session state — and sessions reintroduce a bearer
 * credential, which is the thing being removed.
 *
 * Signing *the request itself* gets the same property without either, because
 * of something the protocol already guarantees. A captured signature is valid
 * only for the exact request it covers — same endpoint, same runner, same
 * body — and every authenticated endpoint here is idempotent by design:
 * `RESULT_IDEMPOTENT` makes a replayed result a no-op, a replayed claim from
 * the same runner returns what that runner already holds, and heartbeat and
 * release are idempotent in effect. So a replay inside the freshness window
 * gains an attacker nothing they could not obtain by forwarding the original,
 * which a relay can do anyway.
 *
 * That is the whole argument, and it is worth stating because it rests
 * entirely on the endpoints being idempotent. Two ways that can fail, and the
 * second is the one that actually bit:
 *
 * 1. **A future endpoint that is not idempotent cannot use this scheme
 *    unchanged** — it would need a server-issued nonce.
 * 2. **Idempotence must hold per *addressed instance*, not per endpoint.** A
 *    request that names a mutable target — a lease, a session, a
 *    subscription — must name the *instance*, or a replay lands on a
 *    different one than the sender meant and the endpoint's idempotence buys
 *    nothing. `release` was idempotent per lease and ambiguous across them:
 *    it named a job and a runner, both of which survive a
 *    claim-release-reclaim cycle, so a replayed release yanked a later grant.
 *    Fixed by giving a lease its own id and requiring it.
 *
 * The rule for anything added later: if a signed request can be replayed onto
 * a target that has changed underneath it, the request has to say which
 * target it meant.
 */

/** How far a request's timestamp may be from the server's clock. */
export const MAX_CLOCK_SKEW_MS = 120_000;

/** The signed material a request carries. */
export const RequestSignature = z
  .object({
    /** Which runner is calling. The server looks up its pinned identity. */
    runnerId: z.string().min(1),
    /** Epoch ms, bounded by {@link MAX_CLOCK_SKEW_MS}. */
    issuedAt: z.number().int().positive(),
    /** Base64url Ed25519 signature over {@link canonicalRequest}. */
    signature: z.string().min(1),
  })
  .strict();
export type RequestSignature = z.infer<typeof RequestSignature>;

/**
 * The exact bytes both sides sign and verify.
 *
 * Newline-separated with a version prefix and a domain separator. Every field
 * that decides what the request *does* is in here: leave one out and it
 * becomes something an intermediary can change without breaking the
 * signature.
 *
 * The body is included by hash rather than by value, so signing does not
 * depend on both sides serialising JSON identically — which they would not.
 */
export function canonicalRequest(input: {
  endpoint: string;
  runnerId: string;
  issuedAt: number;
  body: string;
}): Buffer {
  const digest = createHash("sha256").update(input.body, "utf8").digest("hex");
  return Buffer.from(
    [
      "byollm/v1/request",
      input.endpoint,
      input.runnerId,
      String(input.issuedAt),
      digest,
    ].join("\n"),
    "utf8",
  );
}

/** Sign an outgoing request with this machine's identity key. */
export function signRequest(
  keys: StoredKeys,
  input: { endpoint: string; runnerId: string; issuedAt: number; body: string },
): RequestSignature {
  return {
    runnerId: input.runnerId,
    issuedAt: input.issuedAt,
    signature: signWith(keys, canonicalRequest(input)),
  };
}

/**
 * The same scheme, for the party at the other end: a **site** calling a relay.
 *
 * A site talking to a relay is in exactly the daemon's position — an outbound
 * caller with an identity keypair the other side already pins — so it gets the
 * daemon's authentication rather than a second scheme. Bearer tokens for the
 * site plane were the alternative, and they would have reintroduced the
 * credential-in-a-file that §4.2 removed from the daemon plane, on the plane
 * that carries *every* site's traffic.
 *
 * Two things make this safe to build on the same canonical string:
 *
 * 1. **The endpoint is namespaced.** Site endpoints sign `site/enqueue`, never
 *    `enqueue`. The daemon plane's `result` and the site plane's `results` are
 *    one character apart, and a naming collision between planes must not be
 *    what stands between a signature and a replay onto the wrong handler. The
 *    prefix is applied *inside* these helpers, so the two ends cannot disagree
 *    about it — the alternative is two implementations of one bound value,
 *    which is this project's most-repeated bug.
 * 2. **The caller slot carries the site id.** `canonicalRequest` names that
 *    field `runnerId` because the daemon plane got there first; here it holds
 *    the site id, and the verifier looks the key up in the projection's site
 *    registry rather than its device registry. The two registries never share
 *    an entry, so a device signature cannot authenticate as a site.
 *
 * §4.2's replay argument carries over **only because the site plane's writes
 * are idempotent per addressed instance**, which is a property that had to be
 * built rather than found: `enqueue` reset a job of the same id, so a replayed
 * enqueue inside the freshness window returned a claimed job to the queue and
 * threw away a device's live lease. Identical in shape to the `release` bug
 * above, on the other plane. Anything added to the site plane later must be
 * idempotent by the instance it names, or this scheme does not cover it.
 */
export function signSiteRequest(
  keys: StoredKeys,
  input: { endpoint: string; siteId: string; issuedAt: number; body: string },
): RequestSignature {
  return signRequest(keys, {
    endpoint: siteEndpoint(input.endpoint),
    runnerId: input.siteId,
    issuedAt: input.issuedAt,
    body: input.body,
  });
}

/** Verify a site's call against the identity the control plane registered. */
export function verifySiteRequest(input: {
  identityPublic: string;
  endpoint: string;
  body: string;
  signature: RequestSignature;
  now: number;
  maxSkewMs?: number;
}): SignatureFailure | null {
  return verifyRequest({
    ...input,
    endpoint: siteEndpoint(input.endpoint),
  });
}

/** The one place the site plane's domain separator is written. */
const siteEndpoint = (endpoint: string): string => `site/${endpoint}`;

/**
 * Why a signed request was refused.
 *
 * **`bad-signature` is never returned verbatim; `stale` is, deliberately.**
 * They are different kinds of refusal and conflating them costs a real user
 * more than it costs an attacker.
 *
 * A bad signature is an authentication failure and the server says only
 * "unauthorized" — telling a prober which part they got wrong is free help.
 *
 * A stale timestamp is a **precondition** failure: the signature may be
 * perfectly valid and the caller's clock is simply wrong. Saying so reveals
 * nothing, for two reasons that both have to hold. The server's time is
 * already public — every response carries a `Date` header and the heartbeat
 * response returns `serverTime` outright. And freshness is checked *before*
 * the signature is verified, so a stale answer says nothing about whether the
 * signature was any good.
 *
 * What conflating them costs: a machine whose clock has drifted gets
 * `401 unauthorized` on every request, forever, with nothing anywhere pointing
 * at the clock. That is the shape byollm_013 was filed about — a refusal that
 * is correct, silent, and sends somebody to read our source.
 */
export type SignatureFailure = "stale" | "bad-signature";

/**
 * Verify a signed request against a runner's pinned identity key.
 *
 * Freshness is checked in **both** directions. A clock far ahead is as much a
 * problem as one behind: it would let a captured request stay replayable long
 * after it was made, which is the one thing the window exists to bound.
 */
export function verifyRequest(input: {
  identityPublic: string;
  endpoint: string;
  body: string;
  signature: RequestSignature;
  now: number;
  maxSkewMs?: number;
}): SignatureFailure | null {
  const skew = input.maxSkewMs ?? MAX_CLOCK_SKEW_MS;
  if (Math.abs(input.now - input.signature.issuedAt) > skew) return "stale";

  const ok = verifyWith(
    input.identityPublic,
    canonicalRequest({
      endpoint: input.endpoint,
      runnerId: input.signature.runnerId,
      issuedAt: input.signature.issuedAt,
      body: input.body,
    }),
    input.signature.signature,
  );
  return ok ? null : "bad-signature";
}
