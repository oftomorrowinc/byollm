import {
  signGrant,
  type GrantClaims,
  type SignedGrant,
  type StoredKeys,
} from "@byollm/protocol";

/**
 * Whatever holds the key that grants are signed with.
 *
 * A function rather than a key, so custody never enters this package. A
 * self-hoster hands over a keypair; a hosted deployment can put the private
 * half behind a KMS and pass a signer that calls it, and the engine cannot
 * tell the difference — which is the point. Custody of the signing key is one
 * of the two things byollm.cloud keeps, and an engine that had to be given
 * the key could not be run any other way.
 *
 * `publicKey` sits on the same object deliberately. It is the value a relay
 * hands a device at pairing, and it is the value that must verify what
 * `sign` produces. Two separate configuration items would be two things a
 * deployment could set inconsistently — and the failure mode is a fleet that
 * refuses every job while every process reports itself healthy.
 */
export interface GrantSigner {
  /** The public half, for a relay to hand devices at pairing. */
  readonly publicKey: string;
  sign(claims: GrantClaims): Promise<SignedGrant> | SignedGrant;
}

/**
 * Sign with a keypair this process holds.
 *
 * The implementation a self-hoster wants, and the one the tests use. A hosted
 * deployment writes its own against whatever holds its key.
 */
export function keypairSigner(
  keys: Pick<StoredKeys, "identityPrivate" | "identityPublic">,
): GrantSigner {
  return {
    publicKey: keys.identityPublic,
    sign: (claims) => signGrant(keys, claims),
  };
}
