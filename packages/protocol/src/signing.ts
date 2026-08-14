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

/** Why a signed request was refused. Never returned to the caller verbatim. */
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
