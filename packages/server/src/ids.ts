import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

/**
 * Alphabet for the user-facing pairing code.
 *
 * Excludes `0/O`, `1/I/L`, `5/S` and `U/V` — a code is read aloud or copied
 * off a terminal into a browser, and a user who mistypes it gets a failure
 * they cannot diagnose. 27 symbols over 8 characters is ~38 bits, which is
 * ample for a code that lives ten minutes, is single-use, and is rate-limited.
 */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRTWXYZ2346789";

/** A device code: the secret the daemon polls with. Never shown to a user. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

/** A runner bearer token. */
export function generateRunnerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A runner id. */
export function generateRunnerId(): string {
  return `runner_${randomUUID()}`;
}

/** A job id. */
export function generateJobId(): string {
  // A bare UUID, not a prefixed one.
  //
  // The app mints this now, because byollm_009 §6 binds the job id into the
  // envelope's signature — so the id must exist before the row does. A
  // `job_`-prefixed string is not a `uuid`, and the Supabase adapter's column
  // is, so the prefix would have made every enqueue fail there while passing
  // in memory. Ids are opaque to the protocol; the prefix was only ever
  // decoration.
  return randomUUID();
}

/**
 * A short code the user reads and confirms, formatted `XXXX-XXXX`.
 * Drawn with rejection sampling so the alphabet stays uniform.
 */
export function generateUserCode(): string {
  const chars: string[] = [];
  while (chars.length < 8) {
    for (const byte of randomBytes(16)) {
      // 256 % 28 !== 0, so bytes at or above the largest whole multiple are
      // discarded rather than folded — folding would bias the low symbols.
      const limit = 256 - (256 % USER_CODE_ALPHABET.length);
      if (byte >= limit) continue;
      const symbol = USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (symbol === undefined) continue;
      chars.push(symbol);
      if (chars.length === 8) break;
    }
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** SHA-256, hex. Tokens and device codes are stored only as this. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking their difference through timing.
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch.
 */
export function secretsMatch(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  return timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
}

/**
 * A fresh id for one lease grant.
 *
 * Not a secret and not guessed at — a daemon is told its lease id in the claim
 * response. It exists to distinguish *this* grant from the next one over the
 * same job by the same runner, which is what stops a replayed release landing
 * on a lease the sender never meant.
 */
export const generateLeaseId = (): string => randomUUID();
