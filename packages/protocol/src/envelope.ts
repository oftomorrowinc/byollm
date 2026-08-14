import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import sodium from "libsodium-wrappers";
import { z } from "zod";
import { signWith, verifyWith, type StoredKeys } from "./keys.js";

/**
 * Sealed, signed envelopes — byollm_009 §6.
 *
 * ## Signed, then sealed
 *
 * An earlier draft specified a bare sealed box. That was wrong in the
 * direction that matters, and the reasoning is kept because someone will
 * propose it again: `crypto_box_seal` is **anonymous-sender by
 * construction** — it derives from an ephemeral keypair and discards the
 * secret — so the recipient can decrypt but learns nothing about who sent it.
 * Both public keys here are public by definition; the upstream distributed
 * them. Any holder of one can therefore produce an envelope that opens
 * cleanly, and a relay holds both.
 *
 * So every envelope is **signed with the sender's Ed25519 identity key, then
 * sealed to the recipient's X25519 encryption key**. The recipient opens it,
 * then verifies against the identity it pinned at consent. An envelope that
 * does not verify is refused, not run.
 *
 * Three details earn their place:
 *
 * - **Both key ids are inside the signature**, so an envelope cannot be
 *   lifted from one recipient and replayed to another, nor re-signed by a
 *   third party claiming authorship.
 * - **`direction` is inside it**, so a payload envelope can never be replayed
 *   as a result envelope.
 * - **Sign-then-encrypt, not encrypt-then-sign.** The signature lives
 *   *inside* the ciphertext, so a relay never accumulates a non-repudiable
 *   record of who sent what to whom. Signing the outside would hand it
 *   exactly the attestation trail `RELAY_BLIND` exists to deny.
 *
 * ## Why libsodium
 *
 * byollm_009 §2: established primitives, no novel constructions. A sealed box
 * is a specific reviewed construction — ephemeral key agreement with a
 * BLAKE2b-derived nonce — and rebuilding it from lower-level pieces is
 * precisely the thing that rule forbids. The keys themselves are Node's,
 * which interoperate: raw X25519 is raw X25519.
 */

/** libsodium is WASM and initialises asynchronously. */
let readied: Promise<void> | undefined;
export async function cryptoReady(): Promise<void> {
  readied ??= sodium.ready;
  await readied;
}

/**
 * How long a sealed payload is worth keeping, from creation.
 *
 * Bound into every envelope and recomputed when one is opened, so it lives
 * here rather than in the two places that need it. Two copies of a value the
 * signature depends on is the same bug as two clock readings: it works until
 * they disagree, and then nothing can be opened.
 *
 * Not a job's TTL. That answers how long the *work* is worth doing, belongs
 * to the app and the store, and may legitimately differ per deployment.
 */
export const ENVELOPE_MAX_AGE_MS = 24 * 60 * 60_000;

/** Which leg an envelope belongs to. Bound into the signature. */
export const EnvelopeDirection = z.enum(["payload", "result"]);
export type EnvelopeDirection = z.infer<typeof EnvelopeDirection>;

export const SealedEnvelope = z
  .object({
    /** Base64url `crypto_box_seal` output over the signed plaintext. */
    ciphertext: z.string().min(1),
    /** Who this was sealed to — the recipient checks it is them. */
    recipientKeyId: z.string().min(1),
    /** Who signed it — the recipient checks this against its pin. */
    senderKeyId: z.string().min(1),
    direction: EnvelopeDirection,
    /**
     * When this ciphertext stops being worth keeping.
     *
     * Carried *on* the envelope rather than recomputed by the opener. An
     * earlier version derived it from the job's creation time, which meant
     * two systems had to agree on a timestamp to the millisecond — and they
     * did not, once a real database rounded it. A bound value that has to be
     * reconstructed is a bound value that eventually is not.
     *
     * Not trusted as written: it is also inside the signature, so a changed
     * deadline fails to verify.
     */
    deadlineAt: z.number().int().positive(),
  })
  .strict();
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

/** Everything the signature covers besides the plaintext itself. */
export interface EnvelopeContext {
  readonly jobId: string;
  readonly senderKeyId: string;
  readonly recipientKeyId: string;
  readonly deadlineAt: number;
  readonly direction: EnvelopeDirection;
}

/** The bytes signed inside the envelope. */
function signedBody(context: EnvelopeContext, plaintext: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: "byollm/v1/envelope",
      jobId: context.jobId,
      senderKeyId: context.senderKeyId,
      recipientKeyId: context.recipientKeyId,
      deadlineAt: context.deadlineAt,
      direction: context.direction,
      plaintext,
    }),
    "utf8",
  );
}

const rawX25519 = (key: KeyObject, part: "x" | "d"): Uint8Array => {
  const jwk = key.export({ format: "jwk" });
  const value = part === "x" ? jwk.x : jwk.d;
  if (typeof value !== "string") throw new Error("not an X25519 key");
  return new Uint8Array(Buffer.from(value, "base64url"));
};

/** Seal a plaintext to a recipient, signed by the sender's identity. */
export async function seal(input: {
  plaintext: string;
  senderKeys: StoredKeys;
  recipientEncryptionPublic: string;
  context: EnvelopeContext;
}): Promise<SealedEnvelope> {
  await cryptoReady();

  const body = signedBody(input.context, input.plaintext);
  const signature = signWith(input.senderKeys, body);
  const inner = JSON.stringify({ body: body.toString("base64url"), signature });

  const recipient = new Uint8Array(
    Buffer.from(input.recipientEncryptionPublic, "base64url"),
  );
  const ciphertext = sodium.crypto_box_seal(
    new Uint8Array(Buffer.from(inner, "utf8")),
    recipient,
  );

  return {
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
    recipientKeyId: input.context.recipientKeyId,
    senderKeyId: input.context.senderKeyId,
    direction: input.context.direction,
    deadlineAt: input.context.deadlineAt,
  };
}

/** Why an envelope was refused. Never distinguished to a remote caller. */
export type EnvelopeFailure =
  | "not-for-us"
  | "unopenable"
  | "malformed"
  | "bad-signature"
  | "context-mismatch";

export type OpenResult =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly reason: EnvelopeFailure };

/**
 * Open an envelope and verify it came from the pinned sender.
 *
 * Every failure returns rather than throws: this runs on input from the
 * network, and a crash here is a denial of service on the delivery path.
 *
 * The context is checked against the signature, not merely read from the
 * envelope. An envelope carries its own claims about who sent it and to
 * whom — believing those would authenticate the attacker's assertion rather
 * than the sender's key.
 */
export async function open(input: {
  envelope: SealedEnvelope;
  recipientKeys: StoredKeys;
  senderIdentityPublic: string;
  /** The deadline is taken from the envelope and checked against its signature. */
  expected: Omit<EnvelopeContext, "deadlineAt">;
}): Promise<OpenResult> {
  await cryptoReady();
  const { envelope, expected } = input;

  // Cheap structural checks first, before any crypto.
  if (
    envelope.recipientKeyId !== expected.recipientKeyId ||
    envelope.senderKeyId !== expected.senderKeyId ||
    envelope.direction !== expected.direction
  ) {
    return { ok: false, reason: "not-for-us" };
  }

  let inner: string;
  try {
    const priv = createPrivateKey({
      key: Buffer.from(input.recipientKeys.encryptionPrivate, "base64"),
      type: "pkcs8",
      format: "der",
    });
    const pub = createPublicKey(priv);
    const opened = sodium.crypto_box_seal_open(
      new Uint8Array(Buffer.from(envelope.ciphertext, "base64url")),
      rawX25519(pub, "x"),
      rawX25519(priv, "d"),
    );
    inner = Buffer.from(opened).toString("utf8");
  } catch {
    // Wrong recipient, tampered ciphertext, or garbage. One reason, because
    // the difference is not something the sender is entitled to learn.
    return { ok: false, reason: "unopenable" };
  }

  let parsed: { body?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(inner) as { body?: unknown; signature?: unknown };
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed.body !== "string" || typeof parsed.signature !== "string") {
    return { ok: false, reason: "malformed" };
  }

  const body = Buffer.from(parsed.body, "base64url");
  if (!verifyWith(input.senderIdentityPublic, body, parsed.signature)) {
    // Opened, but not from the key we pinned. This is the injection case: a
    // relay can produce a well-formed sealed box for any public key it holds.
    return { ok: false, reason: "bad-signature" };
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // The signature is valid over *something*; this checks it is valid over
  // what we asked for. Without it a genuinely signed envelope for another
  // job, recipient or leg would verify here.
  if (
    claims["jobId"] !== expected.jobId ||
    claims["senderKeyId"] !== expected.senderKeyId ||
    claims["recipientKeyId"] !== expected.recipientKeyId ||
    claims["deadlineAt"] !== envelope.deadlineAt ||
    claims["direction"] !== expected.direction
  ) {
    return { ok: false, reason: "context-mismatch" };
  }
  if (typeof claims["plaintext"] !== "string") {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, plaintext: claims["plaintext"] };
}
