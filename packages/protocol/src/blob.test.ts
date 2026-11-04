import { describe, expect, it } from "vitest";
import {
  BLOB_NONCE_BYTES,
  BLOB_TAG_BYTES,
  blobObjectBytes,
  decryptBlob,
  encryptBlob,
  isBlobObjectSize,
  newBlobId,
  sniffImage,
} from "./blob.js";
import { BLOB_PADDING_BYTES, BlobRef } from "./media.js";

/** A minimal PNG header: signature and IHDR, which is all the sniffer reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpegHeader(width: number, height: number): Uint8Array {
  // SOI, an APP0 of length 4, then SOF0.
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
}

function webp(chunk: string, body: number[]): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...Buffer.from("RIFF")], 0);
  b.set([...Buffer.from("WEBP")], 8);
  b.set([...Buffer.from(chunk)], 12);
  b.set(body, 20);
  return b;
}

async function sealed(bytes: Uint8Array, jobId = "job-1") {
  const blob = newBlobId();
  const out = await encryptBlob({
    plaintext: bytes,
    jobId,
    blobId: blob,
    direction: "in",
  });
  const ref = BlobRef.parse({
    blob,
    mediaType: "image/png",
    bytes: bytes.length,
    width: 2,
    height: 3,
    sha256: out.sha256,
    key: out.key,
  });
  return { ...out, ref };
}

describe("blobs — byollm_021 §2", () => {
  it("pads to the bucket and adds nonce and tag, and nothing finer", async () => {
    const { object } = await sealed(pngHeader(2, 3));
    expect(object.length).toBe(
      BLOB_PADDING_BYTES + BLOB_NONCE_BYTES + BLOB_TAG_BYTES,
    );
    expect(blobObjectBytes(BLOB_PADDING_BYTES + 1)).toBe(
      2 * BLOB_PADDING_BYTES + BLOB_NONCE_BYTES + BLOB_TAG_BYTES,
    );
    expect(isBlobObjectSize(object.length)).toBe(true);
    expect(isBlobObjectSize(object.length + 1)).toBe(false);
    expect(isBlobObjectSize(BLOB_NONCE_BYTES + BLOB_TAG_BYTES)).toBe(false);
  });

  it("opens under its own job, blob and direction, and returns the image", async () => {
    const image = pngHeader(2, 3);
    const { object, ref } = await sealed(image);
    const opened = await decryptBlob({
      object,
      ref,
      jobId: "job-1",
      direction: "in",
    });
    expect(opened).toEqual({ ok: true, bytes: image });
  });

  it("[BLOB_BOUND_TO_JOB] refuses another job, the other direction, and one flipped byte", async () => {
    const { object, ref } = await sealed(pngHeader(2, 3));
    const otherJob = await decryptBlob({
      object,
      ref,
      jobId: "job-2",
      direction: "in",
    });
    const otherWay = await decryptBlob({
      object,
      ref,
      jobId: "job-1",
      direction: "out",
    });
    const flipped = object.slice();
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    const tampered = await decryptBlob({
      object: flipped,
      ref,
      jobId: "job-1",
      direction: "in",
    });
    for (const result of [otherJob, otherWay, tampered]) {
      expect(result.ok ? "opened" : result.why).toBe("decrypt");
    }
  });

  it("refuses an object that is not the size its reference declares, before decrypting", async () => {
    const { object, ref } = await sealed(pngHeader(2, 3));
    const longer = new Uint8Array(object.length + BLOB_PADDING_BYTES);
    longer.set(object);
    const result = await decryptBlob({
      object: longer,
      ref,
      jobId: "job-1",
      direction: "in",
    });
    expect(result.ok ? "opened" : result.why).toBe("size");
  });

  it("[BLOB_BOUND_TO_JOB] refuses a plaintext whose hash is not its reference's", async () => {
    const { object, ref } = await sealed(pngHeader(2, 3));
    const result = await decryptBlob({
      object,
      ref: { ...ref, sha256: "0".repeat(64) },
      jobId: "job-1",
      direction: "in",
    });
    expect(result.ok ? "opened" : result.why).toBe("sha256");
  });

  it("[MEDIA_VERIFIED] refuses a declared type or size the bytes do not bear out", async () => {
    const { object, ref } = await sealed(pngHeader(2, 3));
    const asJpeg = await decryptBlob({
      object,
      ref: { ...ref, mediaType: "image/jpeg" },
      jobId: "job-1",
      direction: "in",
    });
    expect(asJpeg.ok ? "opened" : asJpeg.why).toBe("media-type");
    const wider = await decryptBlob({
      object,
      ref: { ...ref, width: 4 },
      jobId: "job-1",
      direction: "in",
    });
    expect(wider.ok ? "opened" : wider.why).toBe("dimensions");
  });

  it("[MEDIA_VERIFIED] refuses a decompression bomb from its header", async () => {
    const bomb = pngHeader(50_000, 50_000);
    const blob = newBlobId();
    const out = await encryptBlob({
      plaintext: bomb,
      jobId: "j",
      blobId: blob,
      direction: "in",
    });
    const result = await decryptBlob({
      object: out.object,
      ref: {
        blob,
        mediaType: "image/png",
        bytes: bomb.length,
        width: 8000,
        height: 8000,
        sha256: out.sha256,
        key: out.key,
      },
      jobId: "j",
      direction: "in",
    });
    expect(result.ok ? "opened" : result.why).toBe("dimensions");
  });
});

describe("sniffImage — byollm_021 §4", () => {
  it("reads PNG, JPEG and all three WebP headers", () => {
    expect(sniffImage(pngHeader(640, 480))).toEqual({
      mediaType: "image/png",
      width: 640,
      height: 480,
    });
    expect(sniffImage(jpegHeader(300, 200))).toEqual({
      mediaType: "image/jpeg",
      width: 300,
      height: 200,
    });
    expect(
      sniffImage(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 100, 0, 50, 0])),
    ).toEqual({ mediaType: "image/webp", width: 100, height: 50 });
    // VP8L: 14 bits of width-1 then 14 of height-1, little-endian.
    const bits = 99 | (49 << 14);
    expect(
      sniffImage(
        webp("VP8L", [
          0x2f,
          bits & 0xff,
          (bits >> 8) & 0xff,
          (bits >> 16) & 0xff,
          (bits >> 24) & 0xff,
        ]),
      ),
    ).toEqual({ mediaType: "image/webp", width: 100, height: 50 });
    expect(sniffImage(webp("VP8X", [0, 0, 0, 0, 99, 0, 0, 49, 0, 0]))).toEqual({
      mediaType: "image/webp",
      width: 100,
      height: 50,
    });
  });

  it("refuses SVG, GIF and anything else", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(gif)).toBeNull();
    expect(sniffImage(new Uint8Array(64))).toBeNull();
  });
});
