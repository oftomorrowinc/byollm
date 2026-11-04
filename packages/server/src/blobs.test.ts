import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BlobRef,
  PROTOCOL_VERSION,
  blobObjectBytes,
  encryptBlob,
  keyId,
  open,
  publicIdentityOf,
  signRequest,
  sniffImage,
  type Capability,
} from "@byollm/protocol";
import { ByollmApp, ImageRefused } from "./app.js";
import { generateSiteKeys } from "./keys.js";
import { BLOB_URL_SEGMENT, openBlobUrl, signBlobUrl } from "./blobs.js";
import { stripImageMetadata } from "./image-metadata.js";
import type { SiteVisionPayload } from "./records.js";
import {
  createHarness,
  httpCapabilities,
  type PairedRunner,
} from "./testing.js";

/**
 * The site's half of byollm_021 §2 and §4 on the direct lane (#7057).
 *
 * `BLOB_BOUND_TO_JOB` and `MEDIA_VERIFIED` hold "at both endpoints". The
 * device's end is C049 and C050 in the daemon's suite
 * (`packages/daemon/src/images.test.ts`, #7136); these are the site's end —
 * what the SDK refuses before an image is uploaded, and before an output
 * reaches the app. Both ends call the protocol's one `decryptBlob`.
 */

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG with a location in its `eXIf` and `tEXt`, and random pixels. */
function png(width = 4, height = 4, extra: Buffer[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("eXIf", Buffer.from("GPS 51.5007N 0.1246W")),
      chunk("tEXt", Buffer.from("Location\u0000Westminster")),
      ...extra,
      chunk(
        "IDAT",
        Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251)),
      ),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

function jpeg(width: number, height: number): Uint8Array {
  const segment = (marker: number, body: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  const sof = Buffer.from([8, 0, 0, 0, 0, 3]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe0, Buffer.from("JFIF\u0000")),
      segment(0xe1, Buffer.from("Exif\u0000\u0000GPS 51.5007N")),
      segment(0xe2, Buffer.from("ICC_PROFILE")),
      segment(0xc0, sof),
      Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]),
    ]),
  );
}

const imageKinds = (): Capability[] => {
  const [base] = httpCapabilities();
  if (base === undefined) throw new Error("no capability");
  return [
    ...httpCapabilities(),
    { ...base, kind: "llm.vision" },
    { ...base, kind: "llm.image" },
  ];
};

async function setup() {
  const h = createHarness();
  const runner = await h.pair({ capabilities: imageKinds() });
  return { h, runner };
}

type H = Awaited<ReturnType<typeof setup>>["h"];

async function claim(h: H, runner: PairedRunner) {
  const claimed = await h.call(
    "claim",
    {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: runner.runnerId,
      capabilities: imageKinds(),
      max: 1,
    },
    runner,
  );
  const job = (
    claimed.body as { jobs: { id: string; lease: { id: string } }[] }
  ).jobs[0];
  if (!job) throw new Error("nothing was offered");
  return job;
}

/** The token at the end of a blob URL. */
const tokenOf = (url: string): string =>
  url.slice(url.indexOf(`/${BLOB_URL_SEGMENT}/`) + BLOB_URL_SEGMENT.length + 2);

/** Run an `llm.image` job to an accepted result whose output is `image`. */
async function imageResult(
  h: H,
  runner: PairedRunner,
  image: Uint8Array,
  declare: Partial<BlobRef> = {},
  sealFor?: { jobId?: string; direction?: "in" | "out" },
) {
  const handle = await h.app.enqueue({
    kind: "llm.image",
    owner: "alice",
    payload: { prompt: "a square" },
  });
  const job = await claim(h, runner);
  const slot = await h.call(
    "blob-slot",
    {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: runner.runnerId,
      jobId: job.id,
      leaseId: job.lease.id,
      bytes: blobObjectBytes(image.length),
    },
    runner,
  );
  expect(slot.status).toBe(200);
  const { blob, url } = slot.body as { blob: string; url: string };
  const sealed = await encryptBlob({
    plaintext: image,
    jobId: sealFor?.jobId ?? job.id,
    blobId: blob,
    direction: sealFor?.direction ?? "out",
  });
  const put = await h.handlers.transferBlob({
    token: tokenOf(url),
    method: "PUT",
    body: new Blob([Uint8Array.from(sealed.object)]).stream(),
  });
  expect(put.status).toBe(204);
  const sniffed = sniffImage(image) ?? {
    mediaType: "image/png" as const,
    width: 4,
    height: 4,
  };
  const ref = BlobRef.parse({
    blob,
    mediaType: sniffed.mediaType,
    bytes: image.length,
    width: sniffed.width,
    height: sniffed.height,
    sha256: sealed.sha256,
    key: sealed.key,
    ...declare,
  });
  const result = await postImageResult(h, runner, job.id, ref);
  expect(result.status).toBe(200);
  return { handle, job, ref, result };
}

/** Post a result through the signed path, not the unsigned shortcut above. */
async function postImageResult(
  h: H,
  runner: PairedRunner,
  jobId: string,
  ref: BlobRef,
) {
  const body = await h.resultBody({
    jobId,
    runner,
    outcome: { outcome: "ok", text: "", images: [ref] },
  });
  return h.call("result", body, runner);
}

describe("the site's input images — byollm_021 §2, §4", () => {
  it("strips the location, pads, encrypts and uploads, and only the device opens it", async () => {
    const { h, runner } = await setup();
    const image = png();
    await h.app.enqueue({
      kind: "llm.vision",
      owner: "alice",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "where was this taken?" },
              { type: "image", image },
            ],
          },
        ],
      },
    });
    const [stored] = h.store.allBlobs();
    expect(stored?.data?.length).toBe(blobObjectBytes(image.length));
    expect(Buffer.from(stored?.data ?? []).includes("GPS")).toBe(false);

    const job = await claim(h, runner);
    const fetched = await h.call(
      "fetch",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        jobId: job.id,
        leaseId: job.lease.id,
      },
      runner,
    );
    const envelope = (
      fetched.body as { envelope: Parameters<typeof open>[0]["envelope"] }
    ).envelope;
    const siteIdentity = (
      await h.call(
        "heartbeat",
        {
          protocolVersion: PROTOCOL_VERSION,
          runnerId: runner.runnerId,
          capabilities: imageKinds(),
          activeLeases: [],
          daemonVersion: "0.1.5",
        },
        runner,
      )
    ).body as { sites: Record<string, { identity: string }> };
    const pinned = Object.values(siteIdentity.sites)[0];
    expect(pinned).toBeDefined();
    const opened = await open({
      envelope,
      recipientKeys: runner.keys,
      senderIdentityPublic: pinned?.identity ?? "",
      expected: {
        jobId: job.id,
        senderKeyId: keyId(pinned?.identity ?? ""),
        recipientKeyId: keyId(publicIdentityOf(runner.keys).identity),
        direction: "payload",
      },
    });
    expect(opened.ok).toBe(true);
    const payload = JSON.parse(opened.ok ? opened.plaintext : "{}") as {
      messages: { content: { type: string; image?: BlobRef }[] }[];
    };
    const ref = payload.messages[0]?.content[1]?.image;
    expect(ref?.mediaType).toBe("image/png");
    // The key is in the sealed payload and nowhere in the store.
    expect(JSON.stringify(h.store.allJobs())).not.toContain(ref?.key);
  });

  it("[MEDIA_VERIFIED] refuses SVG, GIF and a decompression bomb before anything is stored", async () => {
    const { h } = await setup();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
    for (const image of [svg, gif, png(50_000, 50_000)]) {
      await expect(
        h.app.enqueue({
          kind: "llm.vision",
          owner: "alice",
          payload: {
            messages: [{ role: "user", content: [{ type: "image", image }] }],
          },
        }),
      ).rejects.toBeInstanceOf(ImageRefused);
    }
    expect(h.store.allBlobs()).toEqual([]);
    expect(h.store.allJobs()).toEqual([]);
  });

  it("refuses images on the cloud lane until the hub serves blobs", async () => {
    const h = createHarness();
    const cloud = new ByollmApp({
      store: h.store,
      siteKeys: generateSiteKeys(),
      lane: { relayOrigin: "https://relay.test", siteId: "site" },
    });
    await expect(
      cloud.enqueue({
        kind: "llm.image",
        owner: "alice",
        payload: { prompt: "a square" },
      }),
    ).rejects.toThrow(/cloud lane/);
  });
});

describe("the site's output images — byollm_021 §2, §4", () => {
  it("opens and verifies an honest output, keeps its key wrapped, and deletes on received", async () => {
    const { h, runner } = await setup();
    const image = png();
    const { handle, ref } = await imageResult(h, runner, image);
    const record = await h.app.job(handle.id);
    expect(JSON.stringify(record)).not.toContain(ref.key);
    expect((await h.app.result(handle.id))?.outcome).toEqual({
      outcome: "ok",
      text: "",
    });
    const images = await handle.images();
    expect(Buffer.from(images[0]?.bytes ?? []).equals(Buffer.from(image))).toBe(
      true,
    );
    expect(h.store.allBlobs()).toEqual([]);
  });

  it("[BLOB_BOUND_TO_JOB] refuses an output sealed for another job", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(
      h,
      runner,
      png(),
      {},
      {
        jobId: "another-job",
      },
    );
    await expect(handle.images()).rejects.toThrow(/did not decrypt/);
  });

  it("[BLOB_BOUND_TO_JOB] refuses an input passed off as an output", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(
      h,
      runner,
      png(),
      {},
      {
        direction: "in",
      },
    );
    await expect(handle.images()).rejects.toThrow(/did not decrypt/);
  });

  it("[BLOB_BOUND_TO_JOB] refuses an output with one byte flipped in the store", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(h, runner, png());
    const [blob] = h.store.allBlobs();
    if (!blob?.data) throw new Error("no stored output");
    const flipped = blob.data.slice();
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    await h.store.putBlob({ ...blob, data: flipped });
    await expect(handle.images()).rejects.toBeInstanceOf(ImageRefused);
  });

  it("[MEDIA_VERIFIED] refuses an output whose bytes are not the declared type", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(h, runner, jpeg(4, 4), {
      mediaType: "image/png",
    });
    await expect(handle.images()).rejects.toThrow(/not image\/png/);
  });

  it("[MEDIA_VERIFIED] refuses an output whose header is over the caps", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(h, runner, png(50_000, 50_000), {
      width: 4,
      height: 4,
    });
    await expect(handle.images()).rejects.toThrow(/dimensions/);
  });

  it("[BLOB_BUDGET_BEFORE_DOWNLOAD] never opens an output larger than declared", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(h, runner, png());
    const [blob] = h.store.allBlobs();
    if (!blob?.data) throw new Error("no stored output");
    const longer = new Uint8Array(blob.data.length + 262_144);
    longer.set(blob.data);
    await h.store.putBlob({ ...blob, data: longer, slotBytes: longer.length });
    await expect(handle.images()).rejects.toThrow(/size/);
  });

  it("refuses a result naming one of the job's inputs, or a blob never uploaded", async () => {
    const { h, runner } = await setup();
    await h.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const job = await claim(h, runner);
    const ghost = BlobRef.parse({
      blob: "never-uploaded",
      mediaType: "image/png",
      bytes: 10,
      width: 1,
      height: 1,
      sha256: "0".repeat(64),
      key: "A".repeat(43),
    });
    const refused = await postImageResult(h, runner, job.id, ghost);
    expect(refused.status).toBe(400);
    expect((await h.app.job(job.id))?.state).not.toBe("ok");
  });
});

describe("blob URLs", () => {
  it("open only for the method, the site and the time they were minted for", async () => {
    const { h } = await setup();
    const keys = generateSiteKeys();
    const grant = {
      blob: "b",
      jobId: "j",
      leaseId: "l",
      method: "GET" as const,
      expiresAt: 2_000,
    };
    const token = signBlobUrl(keys, grant);
    const identity = publicIdentityOf(keys).identity;
    expect(openBlobUrl(identity, token, 1_000)).toEqual(grant);
    expect(openBlobUrl(identity, token, 2_000)).toBeNull();
    const [body, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...grant, method: "PUT" }),
    ).toString("base64url");
    expect(
      openBlobUrl(identity, `${forged}.${signature ?? ""}`, 1_000),
    ).toBeNull();
    expect(
      openBlobUrl(identity, `${body ?? ""}.${signature ?? ""}.x`, 1_000),
    ).toBeNull();
    const other = publicIdentityOf(generateSiteKeys()).identity;
    expect(openBlobUrl(other, token, 1_000)).toBeNull();
    // And through the handler: a token this site never minted is not found.
    expect(
      (await h.handlers.transferBlob({ token, method: "GET" })).status,
    ).toBe(404);
  });
});

describe("stripImageMetadata — byollm_021 §4", () => {
  it("takes Exif and text out of a PNG and keeps the pixels", () => {
    const image = png();
    const stripped = stripImageMetadata(image, "image/png");
    expect(stripped).not.toBeNull();
    const text = Buffer.from(stripped ?? []);
    expect(text.includes("eXIf")).toBe(false);
    expect(text.includes("Westminster")).toBe(false);
    expect(text.includes("IDAT")).toBe(true);
    expect(sniffImage(stripped ?? new Uint8Array())).toEqual(sniffImage(image));
  });

  it("takes APP1 out of a JPEG and keeps JFIF, the colour profile and the scan", () => {
    const stripped = Buffer.from(
      stripImageMetadata(jpeg(3, 2), "image/jpeg") ?? [],
    );
    expect(stripped.includes("Exif")).toBe(false);
    expect(stripped.includes("JFIF")).toBe(true);
    expect(stripped.includes("ICC_PROFILE")).toBe(true);
    expect(sniffImage(stripped)).toEqual({
      mediaType: "image/jpeg",
      width: 3,
      height: 2,
    });
  });

  it("takes the EXIF and XMP chunks out of a WebP and clears their flags", () => {
    const riffChunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, "ascii");
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([
        head,
        body,
        body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
      ]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04;
    vp8x.writeUIntLE(99, 4, 3);
    vp8x.writeUIntLE(49, 7, 3);
    const body = Buffer.concat([
      riffChunk("VP8X", vp8x),
      riffChunk("EXIF", Buffer.from("GPS 51.5007N")),
      riffChunk("XMP ", Buffer.from("<x:xmpmeta/>")),
    ]);
    const header = Buffer.alloc(12);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(body.length + 4, 4);
    header.write("WEBP", 8, "ascii");
    const stripped = stripImageMetadata(
      Uint8Array.from(Buffer.concat([header, body])),
      "image/webp",
    );
    const out = Buffer.from(stripped ?? []);
    expect(out.includes("GPS")).toBe(false);
    expect(out.includes("xmpmeta")).toBe(false);
    expect((out[20] ?? 0) & 0x0c).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(sniffImage(out)).toEqual({
      mediaType: "image/webp",
      width: 100,
      height: 50,
    });
  });

  it("refuses an image it cannot walk rather than passing it through", () => {
    expect(stripImageMetadata(png().subarray(0, 40), "image/png")).toBeNull();
  });
});

describe("the blob endpoints' refusals", () => {
  const slotBody = (
    runner: PairedRunner,
    job: { id: string; lease: { id: string } },
    bytes = blobObjectBytes(10),
  ) => ({
    protocolVersion: PROTOCOL_VERSION,
    runnerId: runner.runnerId,
    jobId: job.id,
    leaseId: job.lease.id,
    bytes,
  });

  it("refuses a slot for another kind, a size no object has, and a fifth slot", async () => {
    const { h, runner } = await setup();
    await h.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const job = await claim(h, runner);
    const odd = await h.call("blob-slot", slotBody(runner, job, 1000), runner);
    expect(odd.status).toBe(400);
    for (let i = 0; i < 4; i += 1) {
      expect(
        (await h.call("blob-slot", slotBody(runner, job), runner)).status,
      ).toBe(200);
    }
    expect(
      (await h.call("blob-slot", slotBody(runner, job), runner)).status,
    ).toBe(400);
    const notMine = await h.call(
      "blob-slot",
      { ...slotBody(runner, job), runnerId: "someone-else" },
      runner,
    );
    expect(notMine.status).toBe(401);

    await h.app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "text" },
    });
    const text = await claim(h, runner);
    expect(
      (await h.call("blob-slot", slotBody(runner, text), runner)).status,
    ).toBe(400);
  });

  it("refuses to mint a URL on a mount that cannot say where it is", async () => {
    const { h, runner } = await setup();
    await h.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const job = await claim(h, runner);
    const body = slotBody(runner, job);
    const rawBody = JSON.stringify(body);
    const result = await h.handlers.handle("blob-slot", body, {
      endpoint: "blob-slot",
      rawBody,
      signature: signRequest(runner.keys, {
        endpoint: "blob-slot",
        runnerId: runner.runnerId,
        issuedAt: h.clock.now(),
        body: rawBody,
      }),
    });
    expect(result.status).toBe(500);
  });

  it("serves a URL once for its method, refuses a second PUT, and refuses an overlong body", async () => {
    const { h, runner } = await setup();
    await h.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const job = await claim(h, runner);
    const slot = await h.call("blob-slot", slotBody(runner, job), runner);
    const { url } = slot.body as { url: string };
    const token = tokenOf(url);
    expect(
      (await h.handlers.transferBlob({ token, method: "GET" })).status,
    ).toBe(404);
    const tooLong = new Uint8Array(blobObjectBytes(10) + 1);
    expect(
      (
        await h.handlers.transferBlob({
          token,
          method: "PUT",
          body: new Blob([tooLong]).stream(),
        })
      ).status,
    ).toBe(413);
    expect(
      (await h.handlers.transferBlob({ token, method: "PUT", body: null }))
        .status,
    ).toBe(204);
    expect(
      (await h.handlers.transferBlob({ token, method: "PUT", body: null }))
        .status,
    ).toBe(409);
  });

  it("refuses a URL for an input that is not this job's", async () => {
    const { h, runner } = await setup();
    await h.app.enqueue({
      kind: "llm.vision",
      owner: "alice",
      payload: {
        messages: [
          { role: "user", content: [{ type: "image", image: png() }] },
        ],
      },
    });
    const job = await claim(h, runner);
    const asked = await h.call(
      "blob-url",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        jobId: job.id,
        leaseId: job.lease.id,
        blob: "not-a-blob",
      },
      runner,
    );
    expect(asked.status).toBe(404);
    const wrongRunner = await h.call(
      "blob-url",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: "someone-else",
        jobId: job.id,
        leaseId: job.lease.id,
        blob: "not-a-blob",
      },
      runner,
    );
    expect(wrongRunner.status).toBe(401);
  });
});

describe("the site SDK's blob calls", () => {
  it("refuses a slot no object could fill, and a second upload under one slot", async () => {
    const { h } = await setup();
    await expect(
      h.app.blobSlot({ jobId: "j", bytes: 7 }),
    ).rejects.toBeInstanceOf(ImageRefused);
    const { blob } = await h.app.blobSlot({
      jobId: "j",
      bytes: blobObjectBytes(1),
    });
    await h.app.uploadBlob(blob, new Uint8Array(blobObjectBytes(1)));
    await expect(
      h.app.uploadBlob(blob, new Uint8Array(1)),
    ).rejects.toBeInstanceOf(ImageRefused);
  });

  it("refuses images() for an unknown job and a job without images", async () => {
    const { h } = await setup();
    await expect(h.app.images("nope")).rejects.toBeInstanceOf(ImageRefused);
    const text = await h.app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "text" },
    });
    await expect(text.images()).rejects.toThrow(/has no images/);
  });

  it("keeps metadata when told to, and refuses an image it cannot strip or that is over the cap", async () => {
    const { h } = await setup();
    const vision = (image: SiteVisionPayload) =>
      h.app.enqueue({ kind: "llm.vision", owner: "alice", payload: image });
    const image = png();
    await vision({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: { bytes: image, keepMetadata: true } },
          ],
        },
      ],
    });
    const [kept] = h.store.allBlobs();
    expect(kept?.data?.length).toBe(blobObjectBytes(image.length));
    await expect(
      vision({
        messages: [
          {
            role: "user",
            content: [{ type: "image", image: png().subarray(0, 40) }],
          },
        ],
      }),
    ).rejects.toThrow(/could not be parsed/);
    await expect(
      vision({
        messages: [
          { role: "user", content: [{ type: "image", image: png(9000, 10) }] },
        ],
      }),
    ).rejects.toThrow(/at most 20 MiB/);
  });

  it("brings an output's deletion forward on collection, never back", async () => {
    const { h, runner } = await setup();
    const { handle } = await imageResult(h, runner, png());
    await h.app.result(handle.id);
    const first = h.store.allBlobs()[0]?.deleteAt;
    h.clock.advance(10 * 60_000);
    await h.app.result(handle.id);
    expect(h.store.allBlobs()[0]?.deleteAt).toBe(first);
    h.clock.advance(60 * 60_000);
    await h.app.sweep();
    expect(h.store.allBlobs()).toEqual([]);
  });
});
