import type { ImageMediaType } from "@byollm/protocol";

/**
 * Take the metadata out of an image before it leaves the site — byollm_021 §4.
 *
 * **Why this is the site's job.** A phone photo carries where it was taken,
 * and a teammate's device should not learn that. The daemon passes input
 * bytes through unchanged, because rewriting an image is decoding it, and a
 * device decoding untrusted images is a surface this protocol does not open.
 * The site has the photo in hand and the person's trust, so it strips.
 *
 * **What goes, and what stays.** Nothing here decodes pixels. Each format is
 * a list of tagged segments, and the ones that carry who, where and when are
 * dropped whole; the ones a viewer needs to show the image correctly stay:
 *
 * - JPEG: `APP1` (Exif and XMP), `APP13` (Photoshop IRB, which carries IPTC)
 *   and `COM` comments go. `APP0` (JFIF), `APP2` (the colour profile) and
 *   `APP14` (Adobe's colour transform) stay.
 * - PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt` (XMP lives there) and `tIME` go.
 * - WebP: the `EXIF` and `XMP ` chunks go, with their flags in `VP8X`.
 *
 * An image this cannot parse is returned as `null` rather than passed through:
 * "stripped" is a promise the SDK makes to the person in the photo, and an
 * unparseable image is one it cannot keep.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
): Uint8Array | null {
  switch (mediaType) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u16be = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number): number =>
  (u16be(b, at) * 0x10000 + u16be(b, at + 2)) >>> 0;
const u32le = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) |
    ((b[at + 1] ?? 0) << 8) |
    ((b[at + 2] ?? 0) << 16) |
    ((b[at + 3] ?? 0) << 24)) >>>
  0;
const ascii = (b: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...b.subarray(at, at + length));

/** JPEG markers that carry metadata about the person or the place. */
const JPEG_DROPPED = new Set([0xe1, 0xed, 0xfe]);

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows, and nothing after it is a
      // segment this walks. Everything from here is kept as it is.
      kept.push(b.subarray(at));
      return concat(kept);
    }
    if (marker === 0xd9) {
      kept.push(b.subarray(at));
      return concat(kept);
    }
    const length = u16be(b, at + 2);
    if (length < 2 || at + 2 + length > b.length) return null;
    if (!JPEG_DROPPED.has(marker)) kept.push(b.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  return null;
}

const PNG_DROPPED = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8) return null;
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (end > b.length) return null;
    if (!PNG_DROPPED.has(type)) kept.push(b.subarray(at, end));
    at = end;
    if (type === "IEND") return concat(kept);
  }
  return null;
}

/** `VP8X` flag bits for the two chunks this removes. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 12) return null;
  const kept: Uint8Array[] = [];
  let at = 12;
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4);
    const length = u32le(b, at + 4);
    // Chunks are padded to an even length.
    const end = at + 8 + length + (length % 2);
    if (end > b.length) return null;
    if (type === "EXIF" || type === "XMP ") {
      at = end;
      continue;
    }
    const chunk = b.slice(at, end);
    if (type === "VP8X" && chunk.length > 8) {
      chunk[8] = (chunk[8] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
    }
    kept.push(chunk);
    at = end;
  }
  if (at !== b.length) return null;
  const body = concat(kept);
  const header = b.slice(0, 12);
  const size = body.length + 4;
  header[4] = size & 0xff;
  header[5] = (size >>> 8) & 0xff;
  header[6] = (size >>> 16) & 0xff;
  header[7] = (size >>> 24) & 0xff;
  return concat([header, body]);
}
