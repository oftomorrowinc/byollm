import { crc32 } from "node:zlib";
import {
  type BlobRef,
  BlobSlotResponse,
  BlobUrlResponse,
  ENVELOPE_MAX_AGE_MS,
  blobObjectBytes,
  cryptoReady,
  decryptBlob,
  encryptBlob,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sniffImage,
  visionImages,
  type Capability,
  type JobKind,
  type VisionPayload,
} from "@byollm/protocol";
import {
  ByollmApp,
  ImageRefused,
  MemoryStore,
  RelayUnavailable,
  generateSiteKeys,
} from "@byollm/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryBlobStore,
  Relay,
  blobJobPrefix,
  slotBytesOf,
} from "../src/index.js";
import { SITE_ID, fixtureFor, makeDaemon } from "./harness.js";

/**
 * Images on the cloud lane, end to end — byollm_021 §2, #7875.
 *
 * `ByollmApp` with a relay lane against the real relay over its HTTP
 * surface, in process, with the relay's memory blob store behind it. The
 * site SDK encrypts, pads, uploads, downloads, verifies and sends
 * `received`; the device is the harness's raw signer using the protocol's
 * own `encryptBlob` and `decryptBlob`, which are the functions a daemon
 * calls. The relay is in the middle of every step and opens nothing.
 *
 * The cloud lane's half of `BLOBS_SEALED` is asserted on the way: what the
 * relay's store and the relay's routing state hold after a round trip is
 * ciphertext and no key.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG with a location in its `tEXt`, and `seed` in its pixels. */
function png(seed: number, width = 4, height = 4): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("tEXt", Buffer.from("Location\u0000Westminster")),
      chunk(
        "IDAT",
        Buffer.from(Array.from({ length: 600 }, (_, i) => (i * seed) % 251)),
      ),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

const capability = (kind: JobKind): Capability => ({
  kind,
  service: "primary",
  backendId: "openai-http",
  backendClass: "http",
  model: "echo-model",
  offerScope: "private",
});

const includes = (haystack: Uint8Array, needle: Uint8Array): boolean =>
  Buffer.from(haystack).includes(Buffer.from(needle));

async function world() {
  const siteKeys = generateSiteKeys();
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  const blobStore = new MemoryBlobStore({ origin: "http://relay.test" });
  const relay = new Relay({ fixture, blobs: { store: blobStore } });
  /** Every request the site made, as method and path. */
  const asked: string[] = [];
  /** Request headers of every `PUT` the site made to the blob store. */
  const putHeaders: string[][] = [];
  const store = new MemoryStore();
  const app = new ByollmApp({
    store,
    siteKeys,
    lane: {
      relayOrigin: "http://relay.test",
      siteId: SITE_ID,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        asked.push(
          `${request.method} ${pathname.replace(/blob-store\/.*/, "blob-store/…")}`,
        );
        if (request.method === "PUT") {
          putHeaders.push([...request.headers.keys()].sort());
        }
        return relay.handle(request);
      },
    },
  });
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site,
    offer: "private",
  });
  disposers.push(daemon.dispose);
  const device = publicIdentityOf(daemon.keys);

  /** Claim as the device, let the site seal, and open the payload. */
  const take = async (jobId: string, kind: JobKind) => {
    const claim = await daemon.signedFetch("claim", {
      capabilities: [capability(kind)],
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((job) => job.id === jobId)?.lease.id;
    if (leaseId === undefined) throw new Error(`${jobId} was not claimed`);
    expect((await app.pump()).sealed).toEqual([jobId]);
    const fetched = await daemon.signedFetch("fetch", { jobId, leaseId });
    expect(fetched.status).toBe(200);
    const { envelope } = (await fetched.json()) as {
      envelope: Parameters<typeof open>[0]["envelope"];
    };
    const opened = await open({
      envelope,
      recipientKeys: daemon.keys,
      senderIdentityPublic: site.identity,
      expected: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(device.identity),
        direction: "payload",
      },
    });
    if (!opened.ok) throw new Error("the device could not open its payload");
    return {
      jobId,
      leaseId,
      payload: JSON.parse(opened.plaintext) as unknown,
    };
  };

  /** Seal an outcome to the site as the device does, and post it. */
  const finish = async (
    job: { jobId: string; leaseId: string },
    outcome: Record<string, unknown>,
  ) => {
    const envelope = await seal({
      plaintext: JSON.stringify({
        outcome,
        ran: {
          model: "echo-model",
          backendClass: "http",
          durationMs: 1,
          stop: "end",
          stopReported: true,
        },
      }),
      senderKeys: daemon.keys,
      recipientEncryptionPublic: site.encryption,
      context: {
        jobId: job.jobId,
        senderKeyId: keyId(device.identity),
        recipientKeyId: keyId(site.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
        direction: "result",
      },
    });
    return daemon.signedFetch("result", {
      jobId: job.jobId,
      leaseId: job.leaseId,
      envelope,
      disposition: outcome["outcome"],
    });
  };

  /** Upload one output image as the device does: slot, encrypt, `PUT`. */
  const upload = async (
    job: { jobId: string; leaseId: string },
    plaintext: Uint8Array,
  ): Promise<BlobRef> => {
    const response = await daemon.signedFetch("blob-slot", {
      jobId: job.jobId,
      leaseId: job.leaseId,
      bytes: blobObjectBytes(plaintext.length),
    });
    expect(response.status).toBe(200);
    const slot = BlobSlotResponse.parse(await response.json());
    const sealed = await encryptBlob({
      plaintext,
      jobId: job.jobId,
      blobId: slot.blob,
      direction: "out",
    });
    const put = await relay.handle(
      new Request(slot.url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(sealed.object.byteLength),
        },
        body: sealed.object,
      }),
    );
    expect(put.status).toBe(200);
    const sniffed = sniffImage(plaintext);
    if (sniffed === null) throw new Error("not an image");
    return {
      blob: slot.blob,
      ...sniffed,
      bytes: plaintext.length,
      sha256: sealed.sha256,
      key: sealed.key,
    };
  };

  /** A finished `llm.image` job with `count` outputs, collected by the site. */
  const imageJob = async (count: number) => {
    const job = await app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square", count },
    });
    const taken = await take(job.id, "llm.image");
    const made = Array.from({ length: count }, (_, n) => png(n + 3));
    const refs: BlobRef[] = [];
    for (const image of made) refs.push(await upload(taken, image));
    expect(
      (await finish(taken, { outcome: "ok", text: "", images: refs })).status,
    ).toBe(200);
    expect((await app.pump()).completed).toEqual([job.id]);
    return { job, taken, made, refs };
  };

  return {
    app,
    store,
    relay,
    blobStore,
    asked,
    putHeaders,
    daemon,
    take,
    finish,
    upload,
    imageJob,
  };
}

describe("llm.vision on the cloud lane — the site uploads, the device downloads", () => {
  it("carries an image from the app to the device holding the lease, and deletes it with the result", async () => {
    const w = await world();
    const photo = png(7, 16, 9);
    const job = await w.app.enqueue({
      kind: "llm.vision",
      owner: "alice",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", image: photo },
            ],
          },
        ],
      },
    });

    // Slot, upload, then the stub — and nothing of the image in the stub.
    expect(w.asked).toEqual([
      "POST /relay/blobs",
      "PUT /relay/blob-store/…",
      "POST /relay/site/enqueue",
    ]);
    // The site's `PUT` carries the ciphertext and its type, and no job tag.
    expect(w.putHeaders).toEqual([["content-type"]]);

    // One object, under this job's name, padded to a bucket: ciphertext.
    const objects = [...w.blobStore.objects()];
    expect(objects).toHaveLength(1);
    const [name, object] = objects[0] ?? ["", new Uint8Array()];
    expect(
      name.startsWith(
        `${blobJobPrefix({ siteId: SITE_ID, jobId: job.id })}in/`,
      ),
    ).toBe(true);
    expect(object.length).toBe(blobObjectBytes(1));
    expect(includes(object, photo.subarray(0, 8))).toBe(false);
    expect(includes(object, Buffer.from("Westminster"))).toBe(false);

    // The device: the reference is in the sealed payload, the bytes behind
    // a URL its lease earns.
    const taken = await w.take(job.id, "llm.vision");
    const [ref] = visionImages(taken.payload as VisionPayload);
    if (ref === undefined) throw new Error("no image in the payload");
    expect(slotBytesOf(ref.blob)).toBe(blobObjectBytes(ref.bytes));
    const asked = await w.daemon.signedFetch("blob-url", {
      jobId: taken.jobId,
      leaseId: taken.leaseId,
      blob: ref.blob,
    });
    expect(asked.status).toBe(200);
    const { url } = BlobUrlResponse.parse(await asked.json());
    const downloaded = new Uint8Array(
      await (await w.relay.handle(new Request(url))).arrayBuffer(),
    );
    const opened = await decryptBlob({
      object: downloaded,
      ref,
      jobId: job.id,
      direction: "in",
    });
    if (!opened.ok) throw new Error(opened.message);
    // What arrived is the photo with its location stripped, as the SDK
    // sends it: same pixels, same header, no `tEXt`.
    expect(sniffImage(opened.bytes)).toEqual({
      mediaType: "image/png",
      width: 16,
      height: 9,
    });
    expect(includes(opened.bytes, Buffer.from("Westminster"))).toBe(false);
    expect(opened.bytes.length).toBe(ref.bytes);

    // The answer comes back, and the input goes with it.
    expect(
      (await w.finish(taken, { outcome: "ok", text: "A striped square." }))
        .status,
    ).toBe(200);
    expect(w.blobStore.objects().size).toBe(0);
    expect((await w.app.pump()).completed).toEqual([job.id]);
    expect((await w.app.result(job.id))?.outcome).toEqual({
      outcome: "ok",
      text: "A striped square.",
    });
  });

  it("uploads a caller's own reference through blobSlot and uploadBlob", async () => {
    const w = await world();
    const jobId = "5b0c9d2e-7a41-4c6f-9d1b-2f3e4a5b6c7d";
    const photo = png(5);
    const { blob } = await w.app.blobSlot({
      jobId,
      bytes: blobObjectBytes(photo.length),
    });
    const sealed = await encryptBlob({
      plaintext: photo,
      jobId,
      blobId: blob,
      direction: "in",
    });
    await w.app.uploadBlob(blob, sealed.object);
    // Once per slot.
    await expect(w.app.uploadBlob(blob, sealed.object)).rejects.toBeInstanceOf(
      RelayUnavailable,
    );
    const job = await w.app.enqueue({
      id: jobId,
      kind: "llm.vision",
      owner: "alice",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: {
                  blob,
                  mediaType: "image/png",
                  bytes: photo.length,
                  width: 4,
                  height: 4,
                  sha256: sealed.sha256,
                  key: sealed.key,
                },
              },
            ],
          },
        ],
      },
    });
    expect(job.id).toBe(jobId);
    expect((await w.relay.state.job(SITE_ID, jobId))?.state).toBe("queued");
  });

  it("is told by the relay when what it stored is not what its slot was for", async () => {
    const w = await world();
    const jobId = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    const photo = png(5);
    const { blob } = await w.app.blobSlot({
      jobId,
      bytes: blobObjectBytes(photo.length),
    });
    const sealed = await encryptBlob({
      plaintext: photo,
      jobId,
      blobId: blob,
      direction: "in",
    });
    // A whole bucket more than the slot was issued for.
    const padded = new Uint8Array(sealed.object.length + 256 * 1024);
    padded.set(sealed.object);
    await w.app.uploadBlob(blob, padded);
    const refused = await w.app
      .enqueue({
        id: jobId,
        kind: "llm.vision",
        owner: "alice",
        payload: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  image: {
                    blob,
                    mediaType: "image/png",
                    bytes: photo.length,
                    width: 4,
                    height: 4,
                    sha256: sealed.sha256,
                    key: sealed.key,
                  },
                },
              ],
            },
          ],
        },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayUnavailable);
    expect((refused as RelayUnavailable).retryable).toBe(false);
    expect((refused as RelayUnavailable).message).toMatch(
      /not the size its slot was issued for/,
    );
    expect(await w.relay.state.job(SITE_ID, jobId)).toBeUndefined();
    expect(w.blobStore.objects().size).toBe(0);
  });
});

describe("llm.image on the cloud lane — the device uploads, the site downloads", () => {
  it("hands the app the device's images, verified, and deletes them once it holds them", async () => {
    const w = await world();
    const { job, made, refs } = await w.imageJob(2);

    // What the relay and its store hold: ciphertext, and no key.
    const everything = Buffer.concat([
      ...[...w.blobStore.objects().values()].map((object) =>
        Buffer.from(object),
      ),
      Buffer.from(JSON.stringify(await w.relay.state.jobs())),
    ]);
    for (const [n, ref] of refs.entries()) {
      expect(everything.includes(ref.key)).toBe(false);
      expect(
        includes(everything, (made[n] ?? new Uint8Array()).subarray(33, 200)),
      ).toBe(false);
    }
    // And what the site's own store holds is each key wrapped, not bare.
    const kept = JSON.stringify(await w.store.get(job.id));
    for (const ref of refs) expect(kept.includes(ref.key)).toBe(false);
    expect(w.blobStore.objects().size).toBe(2);

    w.asked.length = 0;
    const images = await job.images();
    expect(images.map((image) => image.mediaType)).toEqual([
      "image/png",
      "image/png",
    ]);
    expect(images.map((image) => Buffer.from(image.bytes))).toEqual(
      made.map((image) => Buffer.from(image)),
    );
    // Download each, then say so — after every one has verified.
    expect(w.asked).toEqual([
      "POST /relay/blobs/download",
      "GET /relay/blob-store/…",
      "POST /relay/blobs/download",
      "GET /relay/blob-store/…",
      "POST /relay/blobs/received",
    ]);
    expect(w.blobStore.objects().size).toBe(0);

    // They are the app's now; the store's copy is gone and says so.
    await expect(job.images()).rejects.toBeInstanceOf(ImageRefused);
  });

  it("keeps the outputs when the app reads them without received", async () => {
    const w = await world();
    const { job } = await w.imageJob(1);
    expect(await job.images({ received: false })).toHaveLength(1);
    expect(w.blobStore.objects().size).toBe(1);
    expect(await job.images({ received: false })).toHaveLength(1);
    await w.app.received(job.id);
    expect(w.blobStore.objects().size).toBe(0);
  });

  it("refuses an output moved to another job, and does not say it holds it", async () => {
    const w = await world();
    const job = await w.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const taken = await w.take(job.id, "llm.image");
    const image = png(11);
    const ref = await w.upload(taken, image);
    // The device references its upload under a key for the same bytes
    // sealed for a different job: the associated data no longer matches.
    const elsewhere = await encryptBlob({
      plaintext: image,
      jobId: "another-job",
      blobId: ref.blob,
      direction: "out",
    });
    expect(
      (
        await w.finish(taken, {
          outcome: "ok",
          text: "",
          images: [{ ...ref, key: elsewhere.key }],
        })
      ).status,
    ).toBe(200);
    expect((await w.app.pump()).completed).toEqual([job.id]);
    w.asked.length = 0;
    await expect(job.images()).rejects.toBeInstanceOf(ImageRefused);
    expect(w.asked).not.toContain("POST /relay/blobs/received");
    expect(w.blobStore.objects().size).toBe(1);
  });

  it("stops a download at the size the reference declares", async () => {
    const w = await world();
    const job = await w.app.enqueue({
      kind: "llm.image",
      owner: "alice",
      payload: { prompt: "a square" },
    });
    const taken = await w.take(job.id, "llm.image");
    // Two buckets stored honestly, declared to the site as one.
    const big = png(13, 400, 400);
    const padded = new Uint8Array(256 * 1024 + 1);
    padded.set(big);
    const ref = await w.upload(taken, padded);
    expect(
      (
        await w.finish(taken, {
          outcome: "ok",
          text: "",
          images: [{ ...ref, bytes: big.length }],
        })
      ).status,
    ).toBe(200);
    expect((await w.app.pump()).completed).toEqual([job.id]);
    const refused = await job.images().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RelayUnavailable);
    expect((refused as RelayUnavailable).message).toMatch(
      /stopped at the declared size/,
    );
  });
});
