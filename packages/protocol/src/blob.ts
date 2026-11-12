import { createHash, randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";
import { z } from "zod";
import { cryptoReady } from "./envelope.js";
import {
  BLOB_PADDING_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  paddedBlobBytes,
  type BlobRef,
  type ImageMediaType,
} from "./media.js";

/**
 * One blob, sealed for the store — byollm_021 §2, ruled on #6933.
 *
 * Both endpoints of a job use this file: the site for its input images and
 * for opening the device's output, the device for the reverse. One
 * implementation, because the associated data and the padding are bound
 * into what decrypts, and two copies of a bound value is the bug this
 * codebase keeps finding.
 *
 * - A fresh 32-byte key per blob, XChaCha20-Poly1305 (IETF), the 24-byte
 *   nonce stored ahead of the ciphertext.
 * - The associated data is `jobId ‖ blobId ‖ direction`, so a blob cannot be
 *   moved to another job, or passed off as an output when it was an input,
 *   without failing to decrypt ({@link MUSTS.BLOB_BOUND_TO_JOB}).
 * - The plaintext is padded with zeros to a multiple of
 *   {@link BLOB_PADDING_BYTES} before it is encrypted, so a store sees a
 *   bucket and never a byte count (Amendment A's rule, reaching media).
 * - The key goes into a {@link BlobRef}, and a `BlobRef` travels only inside
 *   a sealed, signed envelope ({@link MUSTS.BLOBS_SEALED}). Nothing here
 *   writes a key anywhere else.
 */

/** Which leg a blob belongs to. Bound into its associated data. */
export const BlobDirection = z.enum(["in", "out"]);
export type BlobDirection = z.infer<typeof BlobDirection>;

/** The nonce stored ahead of each blob's ciphertext. */
export const BLOB_NONCE_BYTES = 24;
/** Poly1305's tag, at the end of each blob's ciphertext. */
export const BLOB_TAG_BYTES = 16;

/**
 * The size of the stored object for an image of `bytes` plaintext: padded,
 * plus nonce and tag.
 *
 * This is the number a slot is issued for and the number an upstream checks
 * a stored object against before a job is offered or a result accepted
 * ({@link MUSTS.BLOB_BUDGET_BEFORE_DOWNLOAD}). A multiple of the padding plus
 * a constant, so it says nothing finer than the bucket does.
 */
export function blobObjectBytes(bytes: number): number {
  return paddedBlobBytes(bytes) + BLOB_NONCE_BYTES + BLOB_TAG_BYTES;
}

/** The largest object a slot is ever issued for: one image at the cap. */
export const MAX_BLOB_OBJECT_BYTES = blobObjectBytes(MAX_IMAGE_BYTES);

/**
 * Whether `size` is a size an object could be stored at — a whole number of
 * padding buckets, plus the overhead, and no more than the cap.
 */
export function isBlobObjectSize(size: number): boolean {
  const body = size - BLOB_NONCE_BYTES - BLOB_TAG_BYTES;
  return (
    Number.isInteger(size) &&
    body >= BLOB_PADDING_BYTES &&
    body % BLOB_PADDING_BYTES === 0 &&
    size <= MAX_BLOB_OBJECT_BYTES
  );
}

/**
 * How long an output blob outlives its result's collection when the site
 * never says it holds it — byollm_021 §2.
 *
 * Here, beside the padding and the caps, because both upstreams delete on
 * it: `@byollm/server` from its own store and a relay from its blob store.
 * One number, so the privacy page's sentence is true on either lane.
 */
export const OUTPUT_KEPT_AFTER_COLLECTION_MS = 60 * 60_000;

/** How long an uncollected job's blobs outlive its deadline — §2. */
export const BLOBS_KEPT_AFTER_DEADLINE_MS = 24 * 60 * 60_000;

/** A blob id: 128 random bits, base64url — what {@link BlobRef.blob} accepts. */
export function newBlobId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * `jobId ‖ blobId ‖ direction`, unambiguously.
 *
 * NUL-separated under a domain tag. A blob id is base64url and a direction is
 * one of two words, so neither can contain the separator; a job id could, in
 * principle, so it goes first and the other two are fixed-alphabet after it.
 */
export function blobAssociatedData(
  jobId: string,
  blobId: string,
  direction: BlobDirection,
): Uint8Array {
  return new TextEncoder().encode(
    `byollm/v1/blob\u0000${jobId}\u0000${blobId}\u0000${direction}`,
  );
}

/** SHA-256 of `bytes`, lowercase hex — {@link BlobRef.sha256}'s form. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What encrypting one image produced. */
export interface SealedBlob {
  /** Nonce, then ciphertext and tag. The bytes the store holds. */
  readonly object: Uint8Array;
  /** The blob's own key, base64url — for its {@link BlobRef} and nowhere else. */
  readonly key: string;
  /** SHA-256 of the plaintext, for its {@link BlobRef}. */
  readonly sha256: string;
}

/**
 * Pad and encrypt one blob under a fresh key.
 *
 * The plaintext is an image already checked by {@link sniffImage}; this does
 * not look at it. The caller puts `key` into the job's sealed payload or
 * sealed result, and `object` into the store.
 */
export async function encryptBlob(input: {
  readonly plaintext: Uint8Array;
  readonly jobId: string;
  readonly blobId: string;
  readonly direction: BlobDirection;
}): Promise<SealedBlob> {
  await cryptoReady();
  const padded = new Uint8Array(paddedBlobBytes(input.plaintext.length));
  padded.set(input.plaintext);
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = sodium.randombytes_buf(BLOB_NONCE_BYTES);
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    padded,
    blobAssociatedData(input.jobId, input.blobId, input.direction),
    null,
    nonce,
    key,
  );
  const object = new Uint8Array(nonce.length + sealed.length);
  object.set(nonce);
  object.set(sealed, nonce.length);
  return {
    object,
    key: Buffer.from(key).toString("base64url"),
    sha256: sha256Hex(input.plaintext),
  };
}

/** Why a blob was refused. One word for the log, never parsed. */
export type BlobRefusal =
  "size" | "decrypt" | "padding" | "sha256" | "media-type" | "dimensions";

export type OpenedBlob =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly why: BlobRefusal; readonly message: string };

/**
 * Open one blob against its reference, or refuse it.
 *
 * Refuses, in order: an object that is not exactly the size its reference
 * declares (so nothing larger than declared is ever decrypted); one that
 * fails to decrypt under this job, this blob id and this direction; padding
 * that is not zeros; a plaintext whose hash is not the reference's
 * ({@link MUSTS.BLOB_BOUND_TO_JOB}); and an image whose bytes are not the
 * type and dimensions the reference declares ({@link MUSTS.MEDIA_VERIFIED}).
 * Only bytes that pass all of them are returned.
 */
export async function decryptBlob(input: {
  readonly object: Uint8Array;
  readonly ref: BlobRef;
  readonly jobId: string;
  readonly direction: BlobDirection;
}): Promise<OpenedBlob> {
  const { ref } = input;
  if (input.object.length !== blobObjectBytes(ref.bytes)) {
    return refuse(
      "size",
      "the stored blob is not the size its reference declares",
    );
  }
  await cryptoReady();
  let padded: Uint8Array;
  try {
    padded = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      input.object.subarray(BLOB_NONCE_BYTES),
      blobAssociatedData(input.jobId, ref.blob, input.direction),
      input.object.subarray(0, BLOB_NONCE_BYTES),
      Buffer.from(ref.key, "base64url"),
    );
  } catch {
    return refuse(
      "decrypt",
      "the blob did not decrypt under this job, this blob and this direction",
    );
  }
  const bytes = padded.slice(0, ref.bytes);
  if (padded.subarray(ref.bytes).some((byte) => byte !== 0)) {
    return refuse("padding", "the blob's padding is not zeros");
  }
  if (sha256Hex(bytes) !== ref.sha256) {
    return refuse(
      "sha256",
      "the blob's plaintext does not match its reference",
    );
  }
  const media = checkImage(bytes, ref);
  if (!media.ok) return media;
  return { ok: true, bytes };
}

/**
 * Hold an image's bytes to what its reference declares — §4.
 *
 * The declared type must be the type the magic bytes say, and the
 * dimensions read from the header must be the declared ones and within the
 * caps. Exported for the endpoint that checks an image before it is
 * referenced at all (a site at upload), as well as after decrypting.
 */
export function checkImage(
  bytes: Uint8Array,
  declared: Pick<BlobRef, "mediaType" | "width" | "height">,
): { readonly ok: true } | Extract<OpenedBlob, { ok: false }> {
  const sniffed = sniffImage(bytes);
  if (sniffed?.mediaType !== declared.mediaType) {
    return refuse(
      "media-type",
      `the bytes are not ${declared.mediaType}${
        sniffed === null ? "" : ` (they are ${sniffed.mediaType})`
      }`,
    );
  }
  if (
    sniffed.width !== declared.width ||
    sniffed.height !== declared.height ||
    !withinImageCaps(sniffed)
  ) {
    return refuse(
      "dimensions",
      "the image's dimensions are not the declared ones, or are over the caps",
    );
  }
  return { ok: true };
}

function refuse(
  why: BlobRefusal,
  message: string,
): Extract<OpenedBlob, { ok: false }> {
  return { ok: false, why, message };
}

/** What an image's header says it is. */
export interface SniffedImage {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

/** Whether an image is within the side and pixel caps (§3). */
export function withinImageCaps(image: {
  readonly width: number;
  readonly height: number;
}): boolean {
  return (
    image.width >= 1 &&
    image.height >= 1 &&
    image.width <= MAX_IMAGE_SIDE &&
    image.height <= MAX_IMAGE_SIDE &&
    image.width * image.height <= MAX_IMAGE_PIXELS
  );
}

/**
 * Read an image's type and dimensions from its header, without decoding —
 * byollm_021 §4.
 *
 * PNG's `IHDR`, JPEG's `SOF`, and WebP's `VP8 `, `VP8L` or `VP8X`. Anything
 * else is `null`: SVG (a document that can carry script), GIF, HEIC, AVIF
 * and every format nobody listed. A decompression bomb is refused by its
 * header, which is the point of reading only the header.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));
const u16be = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number): number =>
  (u16be(b, at) * 0x10000 + u16be(b, at + 2)) >>> 0;
const u16le = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number =>
  u16le(b, at) | ((b[at + 2] ?? 0) << 16);

function sniffPng(b: Uint8Array): SniffedImage | null {
  if (b.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return null;
  // IHDR is required to be the first chunk.
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return { mediaType: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function sniffJpeg(b: Uint8Array): SniffedImage | null {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    // Fill bytes, and the markers that stand alone without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > b.length) return null;
      return {
        mediaType: "image/jpeg",
        height: u16be(b, at + 5),
        width: u16be(b, at + 7),
      };
    }
    // Start of scan with no frame before it is not an image we can measure.
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

function sniffWebp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30) return null;
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes), start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return {
      mediaType: "image/webp",
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits =
      ((b[21] ?? 0) |
        ((b[22] ?? 0) << 8) |
        ((b[23] ?? 0) << 16) |
        ((b[24] ?? 0) << 24)) >>>
      0;
    return {
      mediaType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      mediaType: "image/webp",
      width: u24le(b, 24) + 1,
      height: u24le(b, 27) + 1,
    };
  }
  return null;
}
