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
  return `job_${randomUUID()}`;
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
