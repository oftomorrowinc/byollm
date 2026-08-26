import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

/**
 * Device and site keys — byollm_009 §3.
 *
 * **Two keypairs per party, and the split is load-bearing.** An Ed25519
 * *identity* key signs; an X25519 *encryption* key receives sealed envelopes.
 * The encryption key is signed by the identity key, and **the identity key is
 * what gets pinned**. So "who sent this" and "who can read this" are answered
 * by different keys — which is what lets an encryption key rotate without
 * re-establishing trust, and what byollm_009 §6's signed-then-sealed envelope
 * depends on.
 *
 * **No new dependency.** byollm_009 §2 says established primitives only, via
 * libsodium. Everything *this* module needs — Ed25519 signing, X25519 key
 * generation — Node provides natively, and using it costs nothing and adds no
 * install weight to a daemon that must land fast on a stranger's laptop.
 *
 * libsodium becomes necessary at envelope v2, where sealing does. That is a
 * real dependency decision and it belongs in the change that needs it: a
 * sealed box is a specific reviewed construction, and rebuilding it out of
 * Node primitives is exactly the "novel construction" §2 rules out. Deferring
 * the dependency is not the same as deferring the rule.
 */

/** A public identity, as it travels on the wire. All values base64url. */
export const PublicIdentity = z
  .object({
    /** Raw Ed25519 public key. The pinned one. */
    identity: z.string().min(1),
    /** Raw X25519 public key, for sealing to this party. */
    encryption: z.string().min(1),
    /**
     * Ed25519 signature over the encryption key, by the identity key.
     *
     * This is what stops an upstream substituting an encryption key of its
     * own while relaying a genuine identity: the receiver pins the identity
     * and refuses any encryption key not signed by it.
     */
    encryptionSig: z.string().min(1),
  })
  .strict();
export type PublicIdentity = z.infer<typeof PublicIdentity>;

/** Private key material, as stored on disk. Never leaves the machine. */
export const StoredKeys = z
  .object({
    version: z.literal(1),
    identityPublic: z.string().min(1),
    identityPrivate: z.string().min(1),
    encryptionPublic: z.string().min(1),
    encryptionPrivate: z.string().min(1),
    encryptionSig: z.string().min(1),
    createdAt: z.number().int().positive(),
  })
  .strict();
export type StoredKeys = z.infer<typeof StoredKeys>;

/** Domain separator, so a signature over an encryption key cannot be
 * replayed as a signature over anything else. */
/**
 * What an encryption key's signature covers.
 *
 * Exported because a rotation is a real event this protocol has to be able to
 * *test* — a record whose encryption key moved under an identity that signed
 * the move is the one case pinning must refuse loudly, and building one
 * outside this file otherwise means re-typing this string, which is how two
 * copies of a constant start disagreeing.
 */
export const ENCRYPTION_KEY_CONTEXT = "byollm/v1/encryption-key";

function rawPublic(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  const x = jwk.x;
  if (typeof x !== "string") throw new Error("key has no raw public component");
  return x;
}

function importPublic(raw: string, crv: "Ed25519" | "X25519"): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv, x: raw }, format: "jwk" });
}

function importPrivate(stored: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(stored, "base64"),
    type: "pkcs8",
    format: "der",
  });
}

const exportPrivate = (key: KeyObject): string =>
  key.export({ type: "pkcs8", format: "der" }).toString("base64");

/** Generate a fresh pair of keypairs and bind them together. */
export function generateKeys(now: number): StoredKeys {
  const identity = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const encryptionPublic = rawPublic(encryption.publicKey);

  return {
    version: 1,
    identityPublic: rawPublic(identity.publicKey),
    identityPrivate: exportPrivate(identity.privateKey),
    encryptionPublic,
    encryptionPrivate: exportPrivate(encryption.privateKey),
    encryptionSig: sign(
      null,
      Buffer.from(`${ENCRYPTION_KEY_CONTEXT}:${encryptionPublic}`),
      identity.privateKey,
    ).toString("base64url"),
    createdAt: now,
  };
}

/** The public half, for the wire. */
export function publicIdentityOf(keys: StoredKeys): PublicIdentity {
  return {
    identity: keys.identityPublic,
    encryption: keys.encryptionPublic,
    encryptionSig: keys.encryptionSig,
  };
}

/**
 * Check that an encryption key really belongs to the identity presenting it.
 *
 * Called on everything received, including from an upstream we otherwise
 * trust — the point of pinning the identity is that nothing else needs to be
 * trusted, and that only holds if this is checked every time rather than at
 * first sight.
 */
export function verifyPublicIdentity(identity: PublicIdentity): boolean {
  try {
    return verify(
      null,
      Buffer.from(`${ENCRYPTION_KEY_CONTEXT}:${identity.encryption}`),
      importPublic(identity.identity, "Ed25519"),
      Buffer.from(identity.encryptionSig, "base64url"),
    );
  } catch {
    // A malformed key is a failed verification, not a crash. This runs on
    // input from the network.
    return false;
  }
}

/** Sign arbitrary bytes with an identity key. */
/**
 * Sign bytes with an identity key.
 *
 * Takes only the private half it uses. A signer that demanded a whole
 * {@link StoredKeys} would make every caller hold an encryption keypair for a
 * job that has no encryption in it — and the control plane, which signs
 * rosters and opens nothing, would be generating and storing secret material
 * it can never need. Every existing caller passes a full `StoredKeys`, which
 * satisfies this.
 */
export function signWith(
  keys: Pick<StoredKeys, "identityPrivate">,
  data: Uint8Array,
): string {
  return sign(null, data, importPrivate(keys.identityPrivate)).toString(
    "base64url",
  );
}

/** Verify bytes against a raw Ed25519 public key. */
export function verifyWith(
  identityPublic: string,
  data: Uint8Array,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      data,
      importPublic(identityPublic, "Ed25519"),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Crockford base32: no `I`, `L`, `O` or `U`, so a fingerprint read aloud
 * cannot be mis-heard as a different one, and cannot spell anything.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A fingerprint a human can compare out loud.
 *
 * 120 bits of SHA-256 over the raw identity key, as six groups of four. Long
 * enough that grinding a colliding key is not worth anyone's afternoon, short
 * enough to read down a phone line — which is the whole point. A fingerprint
 * nobody can be bothered to compare provides no security at all, so
 * legibility is a security property here, not a nicety.
 *
 * Formatted with a `BYOLLM-` prefix so a pasted fingerprint is recognisable
 * out of context, in a support thread or a screenshot.
 */
export function fingerprint(identityPublic: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(identityPublic, "base64url"))
    .digest();

  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest.subarray(0, 15)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }

  const groups = out.match(/.{1,4}/g) ?? [];
  return `BYOLLM-${groups.join("-")}`;
}

/** The short id used in envelopes and provenance. Stable, and comparable. */
export const keyId = (identityPublic: string): string =>
  fingerprint(identityPublic);
