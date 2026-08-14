import {
  ENVELOPE_MAX_AGE_MS,
  keyId,
  open,
  publicIdentityOf,
  seal,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
} from "@byollm/protocol";

/**
 * Open this site's own at-rest envelope and re-seal it to a claiming device.
 *
 * The single operation that makes byollm_009 §6 work, and it now has two
 * callers: {@link ByollmHandlers} answering `fetch` on the direct plane, and
 * the cloud lane answering the relay's "who claimed it" poll. Both do exactly
 * this, and the reason it lives in one file is the reason everything else in
 * this codebase does: the deadline, the key ids and the direction are all
 * bound into a signature, and two implementations of a bound value is the same
 * bug as two clock readings — it works until they disagree, and then nothing
 * opens.
 *
 * The plaintext exists for one statement and never reaches a wire, a store, or
 * a log. That is the whole guarantee: the site is an endpoint, so it is
 * entitled to read its own work, and it is the only party between the app and
 * the device that is.
 */

type ResealFailure = "unopenable";

export type ResealResult =
  | { readonly ok: true; readonly envelope: SealedEnvelope }
  | { readonly ok: false; readonly reason: ResealFailure };

export async function resealForDevice(input: {
  siteKeys: StoredKeys;
  /** The job's identity and its at-rest ciphertext. */
  job: {
    readonly id: string;
    readonly envelope: SealedEnvelope;
    readonly createdAt: number;
  };
  /** The device that claimed it, as the upstream reported. */
  device: PublicIdentity;
}): Promise<ResealResult> {
  const senderKeyId = keyId(publicIdentityOf(input.siteKeys).identity);

  const opened = await open({
    envelope: input.job.envelope,
    recipientKeys: input.siteKeys,
    senderIdentityPublic: input.siteKeys.identityPublic,
    expected: {
      jobId: input.job.id,
      senderKeyId,
      recipientKeyId: senderKeyId,
      direction: "payload",
    },
  });
  if (!opened.ok) {
    // The store holds something this site cannot open: rotated keys, a
    // corrupted row, or someone else's envelope. Not the device's problem and
    // not something a retry fixes.
    return { ok: false, reason: "unopenable" };
  }

  const envelope = await seal({
    plaintext: opened.plaintext,
    senderKeys: input.siteKeys,
    recipientEncryptionPublic: input.device.encryption,
    context: {
      jobId: input.job.id,
      senderKeyId,
      recipientKeyId: keyId(input.device.identity),
      // From the record, never recomputed from a fresh clock read — the
      // envelope's own deadline is what the signature bound.
      deadlineAt: input.job.createdAt + ENVELOPE_MAX_AGE_MS,
      direction: "payload",
    },
  });
  return { ok: true, envelope };
}
