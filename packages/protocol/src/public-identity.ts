import { z } from "zod";

/**
 * A party's public keys, as they travel — extracted from `keys.ts` for B018c.
 *
 * ## Why it lives on its own
 *
 * The browser end of a console session needs this SCHEMA at runtime, and
 * `keys.ts` is irreducibly node-only: `generateKeyPairSync`,
 * `createPrivateKey`, `createHash`. So every route to the console types
 * dragged the node world into a bundle meant for a tab.
 *
 * Nothing about the shape changed. `keys.ts` re-exports it, so every existing
 * import still resolves and the wire is untouched — this is a file move, and
 * the tests that were passing before it are the proof.
 *
 * Pure zod: no crypto, no node, nothing to make unportable later.
 */
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
