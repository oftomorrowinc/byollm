import { z } from "zod";

/**
 * Images by reference — byollm_021, ruled on #6933 (2026-11-03).
 *
 * The envelope stays at most {@link MAX_ENVELOPE_BYTES} and carries
 * references; bytes never ride inside it, even when a small image would fit
 * (§2). Each image is its own blob in object storage, encrypted before it
 * leaves the endpoint that made it, under a fresh key that travels **only
 * inside the sealed, signed envelope** ({@link MUSTS.BLOBS_SEALED}). Whoever
 * stores the blob holds ciphertext and nothing that opens it, which is how
 * `RELAY_BLIND` reaches media.
 *
 * This file is the reference and the numbers. Encrypting, padding, sniffing
 * and the blob endpoints belong to the cards that build them (§Rollout R8,
 * cards 5 and 6).
 */

/** 20 MiB an image, in or out — a full-resolution phone photo as JPEG (§3). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Images in one `llm.vision` job (§1, §3). */
export const MAX_IMAGES_IN = 8;

/** Images one `llm.image` job may ask for, and return — the `count` ceiling (§3). */
export const MAX_IMAGES_OUT = 4;

/** Pixels a side. A 20 MiB PNG can decode to gigabytes; this refuses it from the header (§3). */
export const MAX_IMAGE_SIDE = 8192;

/** 40 megapixels. Binds before {@link MAX_IMAGE_SIDE} does on a square image (§3). */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Every blob is padded to a multiple of this before it is encrypted (§2).
 *
 * Amendment A's rule is that the router sees a bucket, never a byte count. A
 * blob store sees each object's size, so padding is how that rule reaches
 * media.
 */
export const BLOB_PADDING_BYTES = 256 * 1024;

/** The size a blob of `bytes` plaintext is stored at, padded (§2). */
export function paddedBlobBytes(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new RangeError("a blob holds at least one byte");
  }
  return Math.ceil(bytes / BLOB_PADDING_BYTES) * BLOB_PADDING_BYTES;
}

/**
 * The image formats, in and out (§4).
 *
 * Refused by omission: SVG, which is a document that can carry script; GIF,
 * which means animation and decoding bombs; HEIC and AVIF, which the site
 * converts. `BlobRef.mediaType` is a closed enum **per kind** (§9), so audio
 * types join a different list for audio kinds without a new reference shape.
 */
export const ImageMediaType = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type ImageMediaType = z.infer<typeof ImageMediaType>;
export const IMAGE_MEDIA_TYPES = Object.freeze(ImageMediaType.options);

/**
 * A reference to one encrypted image blob — byollm_021 §2.
 *
 * ```
 * BlobRef = { blob, mediaType, bytes, width, height, sha256, key }
 * ```
 *
 * - `blob` — the store's id for the object, issued with its upload slot.
 * - `bytes` — the plaintext size, before padding. A teammate's job is
 *   budgeted on this **before any blob is downloaded**, and a download stops
 *   at it ({@link MUSTS.BLOB_BUDGET_BEFORE_DOWNLOAD}).
 * - `width`, `height` — read from the header without decoding, and held to
 *   the caps here so that a decompression bomb is refused from its reference.
 * - `sha256` — of the plaintext, checked after decrypting
 *   ({@link MUSTS.BLOB_BOUND_TO_JOB}).
 * - `key` — the blob's own 32-byte XChaCha20-Poly1305 key, base64url. It
 *   exists only inside a sealed, signed envelope, which is the whole of
 *   {@link MUSTS.BLOBS_SEALED}.
 *
 * The direction (`in` or `out`) is not carried. It is part of the blob's
 * associated data (`jobId ‖ blobId ‖ direction`) and is known from where the
 * reference sits: a payload's are `in`, a result's are `out`.
 */
export const BlobRef = z
  .object({
    blob: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, {
      message: "a blob id is 1 to 128 base64url characters",
    }),
    mediaType: ImageMediaType,
    bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
    width: z.number().int().min(1).max(MAX_IMAGE_SIDE),
    height: z.number().int().min(1).max(MAX_IMAGE_SIDE),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, {
      message: "sha256 is 64 lowercase hex digits",
    }),
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, {
      message: "a blob key is 32 bytes, base64url without padding",
    }),
  })
  .strict()
  .refine((ref) => ref.width * ref.height <= MAX_IMAGE_PIXELS, {
    message: `an image is at most ${String(MAX_IMAGE_PIXELS)} pixels`,
  });
export type BlobRef = z.infer<typeof BlobRef>;
