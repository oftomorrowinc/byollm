import {
  BLOB_PADDING_BYTES,
  BLOBS_KEPT_AFTER_DEADLINE_MS,
  BlobSlotResponse,
  BlobUrlResponse,
  ENVELOPE_MAX_AGE_MS,
  MAX_IMAGES_IN,
  MAX_IMAGES_OUT,
  OUTPUT_KEPT_AFTER_COLLECTION_MS,
  PROTOCOL_VERSION,
  SiteBlobDownloadResponse,
  SiteBlobSlotResponse,
  blobObjectBytes,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  signSiteRequest,
  type Capability,
  type JobKind,
  type JobStub,
  type StoredKeys,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryBlobLedger,
  MemoryBlobStore,
  ORPHAN_BLOB_AGE_MS,
  Relay,
  blobAddressOf,
  blobJobPrefix,
  blobObjectName,
  mintBlobId,
  slotBytesOf,
  type BlobAddress,
  type BlobLedger,
  type RelayFixture,
} from "../src/index.js";
import { RelayState } from "../src/state.js";
import { SITE_ID, fixtureFor, makeDaemon, siteHeaders } from "./harness.js";

/**
 * The relay's blob routes against the memory store — byollm_021 §2, #7875.
 *
 * The cloud lane's halves of four checks, as 021 §10 names them, through the
 * relay's whole HTTP surface:
 *
 * - **C053** blob needs the lease: no lease, no URL — and no lease on one
 *   job reaches another job's blob.
 * - **C057** blob size checked before offer: a slot's size is recorded, and
 *   a job whose stored blob is missing or differs from it is refused at
 *   enqueue and never offered. The same check on outputs, at result.
 * - **C054** blobs go with the job: inputs when the result is accepted,
 *   outputs on `received`, and an uncollected job's a day after its
 *   deadline.
 * - **C059** output outlives collection until received: collecting deletes
 *   nothing; an hour later, without `received`, the sweep does.
 *
 * The daemon is the harness's raw signer, and the bytes are random: what is
 * under test is what the relay issues, checks and deletes, none of which
 * reads a byte. Real images, sealed and opened at both ends, go through
 * these routes in `blobs-sdk.test.ts`.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

const LEASE_MS = 30_000;
const ORIGIN = "http://relay.test";
const ONE_BUCKET = blobObjectBytes(1);
const TWO_BUCKETS = blobObjectBytes(BLOB_PADDING_BYTES + 1);

const capability = (kind: JobKind): Capability => ({
  kind,
  service: "primary",
  backendId: "openai-http",
  backendClass: "http",
  model: "echo-model",
  offerScope: "private",
});
const IMAGE_KINDS = [
  capability("llm.vision"),
  capability("llm.image"),
  capability("llm.chat"),
];

/** A blob store that counts what it signs, so "no URL issued" is a number. */
class CountingStore extends MemoryBlobStore {
  urls = 0;
  slots = 0;
  failing = false;
  override url(address: BlobAddress) {
    if (this.failing) return Promise.reject(new Error("bucket unreachable"));
    this.urls += 1;
    return super.url(address);
  }
  override slot(address: BlobAddress, bytes: number) {
    if (this.failing) return Promise.reject(new Error("bucket unreachable"));
    this.slots += 1;
    return super.slot(address, bytes);
  }
}

async function world(
  options: {
    /** `false` for a relay whose host gave it no blob store. */
    blobs?: boolean;
    ledger?: BlobLedger;
    fixture?: (site: ReturnType<typeof publicIdentityOf>) => RelayFixture;
  } = {},
) {
  const clock = { at: Date.now() };
  const siteKeys = generateKeys(clock.at);
  const site = publicIdentityOf(siteKeys);
  const fixture = options.fixture?.(site) ?? fixtureFor(site);
  const state = new RelayState({ now: () => clock.at });
  const blobStore = new CountingStore({ origin: ORIGIN, now: () => clock.at });
  const ledger = options.ledger ?? new MemoryBlobLedger();
  const relay = new Relay({
    fixture,
    store: state,
    leaseMs: LEASE_MS,
    now: () => clock.at,
    ...(options.blobs === false ? {} : { blobs: { store: blobStore, ledger } }),
  });
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site,
    offer: "private",
  });
  disposers.push(daemon.dispose);
  const device = publicIdentityOf(daemon.keys);

  /** A signed site-plane POST to `path`, signed under `endpoint`. */
  const sitePostAs = async (
    keys: StoredKeys,
    siteId: string,
    path: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const rawBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId,
      ...body,
    });
    const signature = signSiteRequest(keys, {
      endpoint,
      siteId,
      issuedAt: Date.now(),
      body: rawBody,
    });
    return relay.handle(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-site": siteId,
          "x-byollm-issued-at": String(signature.issuedAt),
          "x-byollm-signature": signature.signature,
        },
        body: rawBody,
      }),
    );
  };
  const sitePost = (endpoint: string, body: Record<string, unknown>) =>
    sitePostAs(siteKeys, SITE_ID, `/relay/site/${endpoint}`, endpoint, body);
  const blobPost = (endpoint: string, body: Record<string, unknown>) =>
    sitePostAs(siteKeys, SITE_ID, `/relay/${endpoint}`, endpoint, body);
  const collect = async () => {
    const response = await relay.handle(
      new Request(
        `${ORIGIN}/relay/site/results?siteId=${SITE_ID}` +
          `&protocolVersion=${PROTOCOL_VERSION}`,
        { headers: siteHeaders(siteKeys, "results", "", Date.now()) },
      ),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { jobs: { jobId: string }[] }).jobs;
  };

  const put = (url: string, bytes: number) =>
    relay.handle(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes).fill(7),
      }),
    );
  const get = (url: string) => relay.handle(new Request(url));

  /** Ask for an input slot and store `stored` bytes under it (0: nothing). */
  const input = async (jobId: string, slotBytes: number, stored: number) => {
    const response = await blobPost("blobs", {
      jobId,
      direction: "in",
      bytes: slotBytes,
    });
    expect(response.status).toBe(200);
    const slot = SiteBlobSlotResponse.parse(await response.json());
    if (stored > 0) expect((await put(slot.url, stored)).status).toBe(200);
    return slot;
  };

  let next = 0;
  const stubFor = (kind: JobKind, jobId?: string): JobStub => {
    next += 1;
    return {
      id: jobId ?? `job_blob_${String(next)}`,
      kind,
      owner: "alice",
      site: keyId(site.identity),
      audience: "private",
      sizeClass: "small",
      streaming: false,
      deadlineAt: clock.at + 15 * 60_000,
    };
  };
  const enqueue = (stub: JobStub) => sitePost("enqueue", { stub });

  /** Claim `jobId` as `who`, seal its payload, and fetch it: running. */
  const run = async (jobId: string, who = daemon) => {
    const claim = await who.signedFetch("claim", {
      capabilities: IMAGE_KINDS,
      max: 1,
    });
    const { jobs } = (await claim.json()) as {
      jobs: { id: string; lease: { id: string } }[];
    };
    const leaseId = jobs.find((job) => job.id === jobId)?.lease.id;
    if (leaseId === undefined) throw new Error(`${jobId} was not claimed`);
    const to = publicIdentityOf(who.keys);
    const payload = await seal({
      plaintext: "{}",
      senderKeys: siteKeys,
      recipientEncryptionPublic: to.encryption,
      context: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(to.identity),
        deadlineAt: clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    expect(
      (await sitePost("payload", { jobId, envelope: payload })).status,
    ).toBe(200);
    expect((await who.signedFetch("fetch", { jobId, leaseId })).status).toBe(
      200,
    );
    return { jobId, leaseId };
  };

  /** Post a result for a held job. The relay cannot open it and does not. */
  const finish = async (
    job: { jobId: string; leaseId: string },
    disposition: "ok" | "error" = "ok",
  ) => {
    const envelope = await seal({
      plaintext: "{}",
      senderKeys: daemon.keys,
      recipientEncryptionPublic: site.encryption,
      context: {
        jobId: job.jobId,
        senderKeyId: keyId(device.identity),
        recipientKeyId: keyId(site.identity),
        deadlineAt: clock.at + ENVELOPE_MAX_AGE_MS,
        direction: "result",
      },
    });
    return daemon.signedFetch("result", { ...job, envelope, disposition });
  };

  /** A queued `llm.vision` job with one correctly stored input. */
  const visionJob = async () => {
    const stub = stubFor("llm.vision");
    const slot = await input(stub.id, ONE_BUCKET, ONE_BUCKET);
    expect((await enqueue(stub)).status).toBe(200);
    return { stub, slot };
  };

  /** A running `llm.image` job, and a way to store an output under it. */
  const imageJob = async () => {
    const stub = stubFor("llm.image");
    expect((await enqueue(stub)).status).toBe(200);
    const job = await run(stub.id);
    const output = async (slotBytes: number, stored: number) => {
      const response = await daemon.signedFetch("blob-slot", {
        ...job,
        bytes: slotBytes,
      });
      expect(response.status).toBe(200);
      const slot = BlobSlotResponse.parse(await response.json());
      if (stored > 0) expect((await put(slot.url, stored)).status).toBe(200);
      return slot;
    };
    return { stub, job, output };
  };

  return {
    clock,
    relay,
    state,
    blobStore,
    ledger,
    fixture,
    site,
    siteKeys,
    daemon,
    sitePost,
    sitePostAs,
    blobPost,
    collect,
    put,
    get,
    input,
    stubFor,
    enqueue,
    run,
    finish,
    visionJob,
    imageJob,
  };
}

const stored = (w: Awaited<ReturnType<typeof world>>) => [
  ...w.blobStore.objects().keys(),
];

describe("a slot's size is recorded — byollm_021 §2", () => {
  it("mints a blob id that carries the size its slot was issued for", async () => {
    const w = await world();
    for (const bytes of [ONE_BUCKET, TWO_BUCKETS, blobObjectBytes(20 << 20)]) {
      const slot = await w.input("job-sizes", bytes, 0);
      expect(slotBytesOf(slot.blob)).toBe(bytes);
    }
    // And the ledger holds each slot against its job, sizes and all.
    const record = await w.ledger.record(SITE_ID, "job-sizes");
    expect(record?.slots.map((slot) => slotBytesOf(slot.blob))).toEqual([
      ONE_BUCKET,
      TWO_BUCKETS,
      blobObjectBytes(20 << 20),
    ]);
  });

  it("refuses a slot that is not whole buckets plus the overhead", async () => {
    const w = await world();
    const response = await w.blobPost("blobs", {
      jobId: "job-odd",
      direction: "in",
      bytes: ONE_BUCKET + 1,
    });
    expect(response.status).toBe(400);
    expect(w.blobStore.slots).toBe(0);
  });

  it("answers the three keys and nothing an uploader must echo", async () => {
    const w = await world();
    const response = await w.blobPost("blobs", {
      jobId: "job-keys",
      direction: "in",
      bytes: ONE_BUCKET,
    });
    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      "blob",
      "expiresAt",
      "url",
    ]);
  });

  it("issues at most eight input slots to a job", async () => {
    const w = await world();
    for (let n = 0; n < MAX_IMAGES_IN; n += 1) {
      await w.input("job-many", ONE_BUCKET, 0);
    }
    const ninth = await w.blobPost("blobs", {
      jobId: "job-many",
      direction: "in",
      bytes: ONE_BUCKET,
    });
    expect(ninth.status).toBe(400);
    expect(w.blobStore.slots).toBe(MAX_IMAGES_IN);
  });

  it("issues no input slot to a job already queued", async () => {
    const w = await world();
    const { stub } = await w.visionJob();
    const late = await w.blobPost("blobs", {
      jobId: stub.id,
      direction: "in",
      bytes: ONE_BUCKET,
    });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("too-late");
  });
});

describe("C057 — blob size checked before offer", () => {
  it("queues a job whose stored blobs are the sizes their slots were issued for", async () => {
    const w = await world();
    const stub = w.stubFor("llm.vision");
    await w.input(stub.id, ONE_BUCKET, ONE_BUCKET);
    await w.input(stub.id, TWO_BUCKETS, TWO_BUCKETS);
    expect((await w.enqueue(stub)).status).toBe(200);
    expect((await w.state.job(SITE_ID, stub.id))?.state).toBe("queued");
  });

  it("refuses a 512 KiB object stored under a 256 KiB slot, and never offers the job", async () => {
    const w = await world();
    const stub = w.stubFor("llm.vision");
    const slot = await w.input(stub.id, ONE_BUCKET, TWO_BUCKETS);
    const refused = await w.enqueue(stub);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe(
      `enqueue refused: blob ${slot.blob} is not the size its slot was issued for`,
    );
    expect(await w.state.job(SITE_ID, stub.id)).toBeUndefined();
    const claim = await w.daemon.signedFetch("claim", {
      capabilities: IMAGE_KINDS,
      max: 4,
    });
    expect(((await claim.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("refuses a job with a slot nothing was uploaded to", async () => {
    const w = await world();
    const stub = w.stubFor("llm.vision");
    await w.input(stub.id, ONE_BUCKET, ONE_BUCKET);
    const empty = await w.input(stub.id, ONE_BUCKET, 0);
    const refused = await w.enqueue(stub);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe(
      `enqueue refused: blob ${empty.blob} was never uploaded`,
    );
    expect(await w.state.job(SITE_ID, stub.id)).toBeUndefined();
  });

  it("refuses an llm.vision job with no input at all", async () => {
    const w = await world();
    const refused = await w.enqueue(w.stubFor("llm.vision"));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /no stored input blob/,
    );
  });

  it("deletes a refused job's inputs with the refusal, so the id starts clean", async () => {
    const w = await world();
    const stub = w.stubFor("llm.vision");
    await w.input(stub.id, ONE_BUCKET, ONE_BUCKET);
    await w.input(stub.id, ONE_BUCKET, TWO_BUCKETS);
    expect((await w.enqueue(stub)).status).toBe(400);
    expect(stored(w)).toEqual([]);
    expect(await w.ledger.record(SITE_ID, stub.id)).toBeUndefined();
    // The same id, uploaded properly this time, is queued.
    await w.input(stub.id, ONE_BUCKET, ONE_BUCKET);
    expect((await w.enqueue(stub)).status).toBe(200);
  });

  it("does not check a republished job again once its inputs went with its result", async () => {
    const w = await world();
    const { stub } = await w.visionJob();
    const job = await w.run(stub.id);
    expect((await w.finish(job)).status).toBe(200);
    expect(stored(w)).toEqual([]);
    // A site that restarts republishes its queue. The job is already
    // routing, so this is that job and not a new one with no inputs.
    expect((await w.enqueue(stub)).status).toBe(200);
    expect((await w.state.job(SITE_ID, stub.id))?.state).toBe("done");
  });

  it("still holds stored blobs to their slots after the ledger forgot the job", async () => {
    // The hub's routing store keeps nothing across a restart. The job is in
    // the object name and the size is in the blob id, so the names are
    // enough: one honest job and one over-stored one, both re-enqueued
    // against a ledger that has never heard of either.
    const forgetful = new MemoryBlobLedger();
    const w = await world({ ledger: forgetful });
    const honest = w.stubFor("llm.vision");
    const cheat = w.stubFor("llm.vision");
    await w.input(honest.id, ONE_BUCKET, ONE_BUCKET);
    await w.input(cheat.id, ONE_BUCKET, TWO_BUCKETS);
    await forgetful.drop({ siteId: SITE_ID, jobId: honest.id });
    await forgetful.drop({ siteId: SITE_ID, jobId: cheat.id });
    expect(await forgetful.record(SITE_ID, honest.id)).toBeUndefined();

    expect((await w.enqueue(cheat)).status).toBe(400);
    expect((await w.enqueue(honest)).status).toBe(200);
    // And the rebuilt record is what the sweep deletes by, a day after the
    // deadline.
    expect((await forgetful.record(SITE_ID, honest.id))?.deleteAt).toBe(
      honest.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS,
    );
  });

  it("holds an ok result's outputs to their slots before accepting it", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    const oversized = await output(ONE_BUCKET, TWO_BUCKETS);
    const refused = await w.finish(job);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe(
      `blob ${oversized.blob} is not the size its slot was issued for`,
    );
    expect((await w.state.job(SITE_ID, job.jobId))?.state).toBe("running");
  });

  it("refuses an ok result with an output slot nothing was uploaded to", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    const empty = await output(ONE_BUCKET, 0);
    const refused = await w.finish(job);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe(
      `blob ${empty.blob} was never uploaded`,
    );
  });

  it("accepts an ok result whose outputs are the sizes their slots were issued for", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    await output(TWO_BUCKETS, TWO_BUCKETS);
    expect((await w.finish(job)).status).toBe(200);
    expect((await w.state.job(SITE_ID, job.jobId))?.state).toBe("done");
  });

  it("holds an ok result to the slots of the lease reporting it, not a lapsed lease's", async () => {
    const w = await world();
    const { stub, job, output } = await w.imageJob();
    // The first device asked for a slot and never filled it, and its lease
    // ran out.
    await output(ONE_BUCKET, 0);
    w.clock.at += LEASE_MS + 1;
    await w.relay.sweep();
    const again = await w.run(stub.id);
    expect(again.leaseId).not.toBe(job.leaseId);
    // The next lease asks for no slot, so nothing has displaced the first
    // lease's. Its result is not refused for a slot it was never issued.
    expect((await w.finish(again)).status).toBe(200);
    expect((await w.state.job(SITE_ID, stub.id))?.state).toBe("done");
  });
});

describe("C053 — blob needs the lease", () => {
  it("issues a URL to the lease's holder, and the URL serves the stored ciphertext", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();
    const job = await w.run(stub.id);
    const response = await w.daemon.signedFetch("blob-url", {
      ...job,
      blob: slot.blob,
    });
    expect(response.status).toBe(200);
    const { url } = BlobUrlResponse.parse(await response.json());
    const object = new Uint8Array(await (await w.get(url)).arrayBuffer());
    expect(object.length).toBe(ONE_BUCKET);
    expect(object.every((byte) => byte === 7)).toBe(true);
  });

  it("issues no URL without the job's lease", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();

    const refusals: [string, Response][] = [];
    // Before any claim: nobody holds a lease on it.
    refusals.push([
      "no claim",
      await w.daemon.signedFetch("blob-url", {
        jobId: stub.id,
        leaseId: "lease-invented",
        blob: slot.blob,
      }),
    ]);

    const job = await w.run(stub.id);
    // The holder, naming a lease that is not the one it holds.
    refusals.push([
      "wrong lease",
      await w.daemon.signedFetch("blob-url", {
        ...job,
        leaseId: "lease-invented",
        blob: slot.blob,
      }),
    ]);
    // Another approved device of the same owner, naming the real lease.
    const other = await makeDaemon(w.relay, w.fixture, {
      owner: "alice",
      site: w.site,
      offer: "private",
    });
    disposers.push(other.dispose);
    refusals.push([
      "another device",
      await other.signedFetch("blob-url", { ...job, blob: slot.blob }),
    ]);
    // The holder, once its lease has run out on the relay's clock.
    w.clock.at += LEASE_MS + 1;
    refusals.push([
      "expired lease",
      await w.daemon.signedFetch("blob-url", { ...job, blob: slot.blob }),
    ]);

    for (const [why, response] of refusals) {
      expect([why, response.status]).toEqual([why, 404]);
      expect(await response.json()).toEqual({
        error: "not-found",
        message: "no such blob under a lease you hold",
      });
    }
    expect(w.blobStore.urls).toBe(0);
  });

  it("issues no URL before the payload is fetched", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();
    const claim = await w.daemon.signedFetch("claim", {
      capabilities: IMAGE_KINDS,
      max: 1,
    });
    const leaseId = (
      (await claim.json()) as { jobs: { lease: { id: string } }[] }
    ).jobs[0]?.lease.id;
    const early = await w.daemon.signedFetch("blob-url", {
      jobId: stub.id,
      leaseId,
      blob: slot.blob,
    });
    expect(early.status).toBe(404);
    expect(w.blobStore.urls).toBe(0);
  });

  it("issues no URL and no upload slot once the job is done, under the lease that finished it", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();
    const read = await w.run(stub.id);
    expect((await w.finish(read)).status).toBe(200);
    // The input went with the result. Put one back at its address, so the
    // only thing between this device and a URL is that the job is finished.
    const address = {
      siteId: SITE_ID,
      jobId: stub.id,
      direction: "in" as const,
      blob: slot.blob,
    };
    const again = await w.blobStore.slot(address, ONE_BUCKET);
    expect((await w.put(again.url, ONE_BUCKET)).status).toBe(200);
    const url = await w.daemon.signedFetch("blob-url", {
      ...read,
      blob: slot.blob,
    });
    expect(url.status).toBe(404);
    expect(w.blobStore.urls).toBe(0);

    // An ok `llm.image` result with most of its lease left: the same lease
    // is issued nothing more to store under a job whose result is recorded.
    const { job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job)).status).toBe(200);
    const before = w.blobStore.slots;
    const late = await w.daemon.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET,
    });
    expect(late.status).toBe(404);
    expect(w.blobStore.slots).toBe(before);
    expect(stored(w).filter((name) => name.includes("/out/"))).toHaveLength(1);
  });

  it("issues no URL and no upload slot for a running job its site has cancelled", async () => {
    const reading = await world();
    const { stub, slot } = await reading.visionJob();
    const read = await reading.run(stub.id);
    expect((await reading.sitePost("cancel", { jobId: stub.id })).status).toBe(
      200,
    );
    // Still claimed, still running, the lease not expired: withdrawn is the
    // one thing that changed.
    expect((await reading.state.job(SITE_ID, stub.id))?.state).toBe("running");
    const url = await reading.daemon.signedFetch("blob-url", {
      ...read,
      blob: slot.blob,
    });
    expect(url.status).toBe(404);
    expect(reading.blobStore.urls).toBe(0);

    const making = await world();
    const { job } = await making.imageJob();
    expect((await making.sitePost("cancel", { jobId: job.jobId })).status).toBe(
      200,
    );
    const before = making.blobStore.slots;
    const late = await making.daemon.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET,
    });
    expect(late.status).toBe(404);
    expect(making.blobStore.slots).toBe(before);
  });

  it("reaches no other job's blob with a lease on this one", async () => {
    const w = await world();
    const mine = await w.visionJob();
    const theirs = await w.visionJob();
    // Claims take the oldest first, so this holds `mine`.
    const job = await w.run(mine.stub.id);
    const response = await w.daemon.signedFetch("blob-url", {
      ...job,
      blob: theirs.slot.blob,
    });
    expect(response.status).toBe(404);
    expect(w.blobStore.urls).toBe(0);
  });

  it("issues no URL for a blob replaced by one of another size after the job was offered", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();
    const job = await w.run(stub.id);
    // What a store that lets a slot be written twice would allow.
    const address = {
      siteId: SITE_ID,
      jobId: stub.id,
      direction: "in" as const,
      blob: slot.blob,
    };
    await w.blobStore.delete(address);
    const again = await w.blobStore.slot(address, ONE_BUCKET);
    expect((await w.put(again.url, TWO_BUCKETS)).status).toBe(200);
    const response = await w.daemon.signedFetch("blob-url", {
      ...job,
      blob: slot.blob,
    });
    expect(response.status).toBe(404);
  });

  it("issues no upload slot without the job's lease", async () => {
    const w = await world();
    const { job } = await w.imageJob();
    const before = w.blobStore.slots;
    const wrongLease = await w.daemon.signedFetch("blob-slot", {
      ...job,
      leaseId: "lease-invented",
      bytes: ONE_BUCKET,
    });
    expect(wrongLease.status).toBe(404);
    const other = await makeDaemon(w.relay, w.fixture, {
      owner: "alice",
      site: w.site,
      offer: "private",
    });
    disposers.push(other.dispose);
    const otherDevice = await other.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET,
    });
    expect(otherDevice.status).toBe(404);
    w.clock.at += LEASE_MS + 1;
    const expired = await w.daemon.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET,
    });
    expect(expired.status).toBe(404);
    expect(w.blobStore.slots).toBe(before);
  });

  it("issues an upload slot only to an llm.image job, and four to a lease", async () => {
    const w = await world();
    const vision = await w.visionJob();
    const held = await w.run(vision.stub.id);
    const notImage = await w.daemon.signedFetch("blob-slot", {
      ...held,
      bytes: ONE_BUCKET,
    });
    expect(notImage.status).toBe(400);
    expect((await w.finish(held)).status).toBe(200);

    const { job, output } = await w.imageJob();
    const odd = await w.daemon.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET - 1,
    });
    expect(odd.status).toBe(400);
    for (let n = 0; n < MAX_IMAGES_OUT; n += 1) {
      await output(ONE_BUCKET, ONE_BUCKET);
    }
    const fifth = await w.daemon.signedFetch("blob-slot", {
      ...job,
      bytes: ONE_BUCKET,
    });
    expect(fifth.status).toBe(400);
    expect(((await fifth.json()) as { message: string }).message).toMatch(
      /every output slot/,
    );
  });

  it("deletes a lapsed lease's outputs when the next lease asks for a slot", async () => {
    const w = await world();
    const { stub, job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    expect(stored(w)).toHaveLength(1);
    w.clock.at += LEASE_MS + 1;
    await w.relay.sweep();
    const again = await w.run(stub.id);
    expect(again.leaseId).not.toBe(job.leaseId);
    const response = await w.daemon.signedFetch("blob-slot", {
      ...again,
      bytes: ONE_BUCKET,
    });
    expect(response.status).toBe(200);
    // The first lease's object is gone; the new slot is not filled yet.
    expect(stored(w)).toEqual([]);
  });
});

describe("the site's download and its address — byollm_021 §2", () => {
  it("issues a site a download URL for its own job's output", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    const slot = await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job)).status).toBe(200);
    const response = await w.blobPost("blobs/download", {
      jobId: job.jobId,
      blob: slot.blob,
    });
    expect(response.status).toBe(200);
    const { url } = SiteBlobDownloadResponse.parse(await response.json());
    expect((await (await w.get(url)).arrayBuffer()).byteLength).toBe(
      ONE_BUCKET,
    );
  });

  it("issues no download for an input, an unknown blob, or an id it did not mint", async () => {
    const w = await world();
    const { stub, slot } = await w.visionJob();
    for (const blob of [slot.blob, mintBlobId(ONE_BUCKET), "not-a-minted-id"]) {
      const response = await w.blobPost("blobs/download", {
        jobId: stub.id,
        blob,
      });
      expect(response.status).toBe(404);
    }
    expect(w.blobStore.urls).toBe(0);
  });

  it("reaches no other site's blob by naming its job and its blob", async () => {
    const otherKeys = generateKeys(Date.now());
    const w = await world({
      fixture: (site) =>
        fixtureFor(site, {
          sites: [
            { siteId: SITE_ID, site },
            { siteId: "site_other", site: publicIdentityOf(otherKeys) },
          ],
        }),
    });
    const { job, output } = await w.imageJob();
    const slot = await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job)).status).toBe(200);

    const asOther = (endpoint: string, body: Record<string, unknown>) =>
      w.sitePostAs(
        otherKeys,
        "site_other",
        `/relay/${endpoint}`,
        endpoint,
        body,
      );
    const download = await asOther("blobs/download", {
      jobId: job.jobId,
      blob: slot.blob,
    });
    expect(download.status).toBe(404);
    // Nor delete it: `received` from another site names nothing of ours.
    const received = await asOther("blobs/received", {
      jobId: job.jobId,
      blobs: [slot.blob],
    });
    expect(received.status).toBe(200);
    expect(stored(w)).toHaveLength(1);
    // And a signature for one site does not carry another site's id.
    const forged = await w.sitePostAs(
      otherKeys,
      "site_other",
      "/relay/blobs/download",
      "blobs/download",
      { siteId: SITE_ID, jobId: job.jobId, blob: slot.blob },
    );
    expect(forged.status).toBe(403);
    expect(w.blobStore.urls).toBe(0);
  });

  it("refuses a blob call that is not signed, or signed for another endpoint", async () => {
    const w = await world();
    const unsigned = await w.relay.handle(
      new Request(`${ORIGIN}/relay/blobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          siteId: SITE_ID,
          jobId: "job-x",
          direction: "in",
          bytes: ONE_BUCKET,
        }),
      }),
    );
    expect(unsigned.status).toBe(401);
    // Signed as `blobs/received`, sent to `blobs/download`.
    const moved = await w.sitePostAs(
      w.siteKeys,
      SITE_ID,
      "/relay/blobs/download",
      "blobs/received",
      { jobId: "job-x", blob: mintBlobId(ONE_BUCKET) },
    );
    expect(moved.status).toBe(401);
  });

  it("keeps the job in the object name, and a hostile id inside one segment", () => {
    const blob = mintBlobId(ONE_BUCKET);
    expect(
      blobObjectName({
        siteId: "site_demo",
        jobId: "3f2b0c1e-job",
        direction: "in",
        blob,
      }),
    ).toBe(`blobs/site_demo/3f2b0c1e-job/in/${blob}`);

    for (const jobId of ["../../other", "a/b", "..", "job id", "é", "~x"]) {
      const name = blobObjectName({
        siteId: SITE_ID,
        jobId,
        direction: "out",
        blob,
      });
      const segments = name.split("/");
      expect(segments).toHaveLength(5);
      expect(segments).not.toContain("..");
      expect(name.startsWith(blobJobPrefix({ siteId: SITE_ID, jobId }))).toBe(
        true,
      );
      // And the name reads back to the address it was written from.
      expect(blobAddressOf(name)).toEqual({
        siteId: SITE_ID,
        jobId,
        direction: "out",
        blob,
      });
    }
    // A name this relay did not write is nobody's address.
    for (const foreign of [
      `other/${SITE_ID}/job/in/${blob}`,
      `blobs/${SITE_ID}/job/in/${blob}/more`,
      `blobs/${SITE_ID}/job/sideways/${blob}`,
      `blobs/${SITE_ID}/job/in/not-a-minted-id`,
      `blobs/${SITE_ID}/~am9i/in/${blob}`,
      `blobs/${SITE_ID}//in/${blob}`,
    ]) {
      expect([foreign, blobAddressOf(foreign)]).toEqual([foreign, null]);
    }
    // An id that needed encoding cannot collide with one that did not.
    const encoded = blobJobPrefix({ siteId: SITE_ID, jobId: "a/b" });
    const plain = blobJobPrefix({
      siteId: SITE_ID,
      jobId: encoded.split("/")[2] ?? "",
    });
    expect(plain).not.toBe(encoded);
    // And no name is built for a blob id this relay did not mint.
    for (const hostile of ["../x", "a/b", "", "x".repeat(22)]) {
      expect(() =>
        blobObjectName({
          siteId: SITE_ID,
          jobId: "job",
          direction: "in",
          blob: hostile,
        }),
      ).toThrow();
    }
  });
});

describe("C054 — blobs go with the job", () => {
  it("deletes the inputs when the result is accepted", async () => {
    const w = await world();
    const { stub } = await w.visionJob();
    const job = await w.run(stub.id);
    expect(stored(w)).toHaveLength(1);
    expect((await w.finish(job)).status).toBe(200);
    expect(stored(w)).toEqual([]);
  });

  it("deletes the outputs when the site says it holds them", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    const first = await output(ONE_BUCKET, ONE_BUCKET);
    const second = await output(TWO_BUCKETS, TWO_BUCKETS);
    expect((await w.finish(job)).status).toBe(200);
    expect(await w.collect()).toHaveLength(1);

    const received = await w.blobPost("blobs/received", {
      jobId: job.jobId,
      blobs: [first.blob, second.blob],
    });
    expect(received.status).toBe(200);
    expect(await received.json()).toEqual({ jobId: job.jobId });
    expect(stored(w)).toEqual([]);
    expect(await w.ledger.record(SITE_ID, job.jobId)).toBeUndefined();
    // Said twice is said once.
    expect(
      (
        await w.blobPost("blobs/received", {
          jobId: job.jobId,
          blobs: [first.blob],
        })
      ).status,
    ).toBe(200);
  });

  it("keeps an ok result's outputs when the same result is replayed as an error", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    const first = await output(ONE_BUCKET, ONE_BUCKET);
    const second = await output(TWO_BUCKETS, TWO_BUCKETS);
    expect((await w.finish(job)).status).toBe(200);
    // The same lease says `error` afterwards. The recorded result stands,
    // and so do the images it names, which the site has not downloaded yet.
    const replay = await w.finish(job, "error");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      accepted: false,
      duplicate: true,
    });
    expect((await w.state.job(SITE_ID, job.jobId))?.disposition).toBe("ok");
    expect(stored(w)).toHaveLength(2);
    for (const slot of [first, second]) {
      const download = await w.blobPost("blobs/download", {
        jobId: job.jobId,
        blob: slot.blob,
      });
      expect(download.status).toBe(200);
      const { url } = SiteBlobDownloadResponse.parse(await download.json());
      expect((await w.get(url)).status).toBe(200);
    }
  });

  it("deletes the outputs of a result that is not ok, which nothing references", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job, "error")).status).toBe(200);
    expect(stored(w)).toEqual([]);
  });

  it("deletes an uncollected job's blobs a day after its deadline, and not before", async () => {
    const w = await world();
    // The image job first: a claim takes the oldest, and it is the one
    // that has to be running to be issued a slot.
    const image = await w.imageJob();
    await image.output(ONE_BUCKET, ONE_BUCKET);
    const vision = await w.visionJob();
    expect(stored(w)).toHaveLength(2);

    w.clock.at = vision.stub.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS - 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    expect(stored(w)).toHaveLength(2);

    // Both jobs were stamped with the same deadline in this world.
    w.clock.at = image.stub.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(2);
    expect(stored(w)).toEqual([]);
  });

  it("deletes a slot's object a day past the oldest an envelope may be, when its job is never enqueued", async () => {
    const w = await world();
    const issuedAt = w.clock.at;
    await w.input("job-never", ONE_BUCKET, ONE_BUCKET);
    w.clock.at =
      issuedAt + ENVELOPE_MAX_AGE_MS + BLOBS_KEPT_AFTER_DEADLINE_MS - 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    w.clock.at += 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(1);
    expect(stored(w)).toEqual([]);
  });
});

describe("C054 — a lost ledger: the sweep reads the store's names", () => {
  it("deletes collected outputs no record covers once they are 48 hours old — not at the hour, and not at day 7", async () => {
    // Owl's Thursday night (#58474): outputs collected and waiting out
    // their hour, the ledger lost, and a site that never calls images().
    // Nothing enqueues the job again, so nothing rebuilds its record.
    const w = await world();
    const { job, output } = await w.imageJob();
    const storedAt = w.clock.at;
    await output(ONE_BUCKET, ONE_BUCKET);
    await output(TWO_BUCKETS, TWO_BUCKETS);
    expect((await w.finish(job)).status).toBe(200);
    expect(await w.collect()).toHaveLength(1);
    await w.ledger.drop({ siteId: SITE_ID, jobId: job.jobId });
    expect(await w.ledger.record(SITE_ID, job.jobId)).toBeUndefined();

    // The hour was the record's to keep, and went with it.
    w.clock.at = storedAt + OUTPUT_KEPT_AFTER_COLLECTION_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    w.clock.at = storedAt + ORPHAN_BLOB_AGE_MS - 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    expect(stored(w)).toHaveLength(2);
    w.clock.at = storedAt + ORPHAN_BLOB_AGE_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(2);
    expect(stored(w)).toEqual([]);
  });

  it("deletes one object its job's record does not name, and leaves the ones it does", async () => {
    // An `llm.image` job with a deadline days away, so its record's clock
    // is later than 48 hours after its outputs were stored.
    const w = await world();
    const stub = {
      ...w.stubFor("llm.image"),
      deadlineAt: w.clock.at + 3 * ORPHAN_BLOB_AGE_MS,
    };
    expect((await w.enqueue(stub)).status).toBe(200);
    const job = await w.run(stub.id);
    const storedAt = w.clock.at;
    const outputs: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const response = await w.daemon.signedFetch("blob-slot", {
        ...job,
        bytes: ONE_BUCKET,
      });
      const slot = BlobSlotResponse.parse(await response.json());
      expect((await w.put(slot.url, ONE_BUCKET)).status).toBe(200);
      outputs.push(slot.blob);
    }
    const [kept, lost] = outputs as [string, string];
    expect((await w.finish(job)).status).toBe(200);
    await w.ledger.drop({
      siteId: SITE_ID,
      jobId: stub.id,
      direction: "out",
      blobs: [lost],
    });

    // 48 hours old, both. The one the record still names waits for that
    // record's clock, a day after a deadline that is days away.
    w.clock.at = storedAt + ORPHAN_BLOB_AGE_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(1);
    expect(stored(w)).toEqual([
      blobObjectName({
        siteId: SITE_ID,
        jobId: stub.id,
        direction: "out",
        blob: kept,
      }),
    ]);
    w.clock.at = stub.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(1);
    expect(stored(w)).toEqual([]);
  });

  it("lists every stored object with its address and when it was stored, from the store alone", async () => {
    const w = await world();
    const first = await w.input("a/b", ONE_BUCKET, ONE_BUCKET);
    w.clock.at += 1_000;
    const second = await w.input("job-plain", TWO_BUCKETS, TWO_BUCKETS);
    await w.input("job-empty", ONE_BUCKET, 0);
    const all = await w.blobStore.storedBefore(w.clock.at);
    expect(all).toEqual([
      {
        address: {
          siteId: SITE_ID,
          jobId: "a/b",
          direction: "in",
          blob: first.blob,
        },
        storedAt: w.clock.at - 1_000,
      },
      {
        address: {
          siteId: SITE_ID,
          jobId: "job-plain",
          direction: "in",
          blob: second.blob,
        },
        storedAt: w.clock.at,
      },
    ]);
    expect(await w.blobStore.storedBefore(w.clock.at - 1)).toHaveLength(1);
  });
});

describe("C059 — output outlives collection until received", () => {
  it("serves every output 30 seconds after collection, and deletes them an hour after it", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    const slot = await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job)).status).toBe(200);
    const collectedAt = w.clock.at;
    expect(await w.collect()).toHaveLength(1);

    w.clock.at += 30_000;
    await w.relay.sweep();
    const download = await w.blobPost("blobs/download", {
      jobId: job.jobId,
      blob: slot.blob,
    });
    expect(download.status).toBe(200);
    const { url } = SiteBlobDownloadResponse.parse(await download.json());
    expect((await w.get(url)).status).toBe(200);

    // Collecting again does not buy another hour.
    w.clock.at = collectedAt + 60_000;
    expect(await w.collect()).toHaveLength(1);

    w.clock.at = collectedAt + OUTPUT_KEPT_AFTER_COLLECTION_MS - 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    expect(stored(w)).toHaveLength(1);
    w.clock.at = collectedAt + OUTPUT_KEPT_AFTER_COLLECTION_MS;
    expect((await w.relay.sweep()).blobsDeleted).toBe(1);
    expect(stored(w)).toEqual([]);
  });

  it("keeps an uncollected result's outputs past the hour", async () => {
    const w = await world();
    const { job, output } = await w.imageJob();
    await output(ONE_BUCKET, ONE_BUCKET);
    expect((await w.finish(job)).status).toBe(200);
    w.clock.at += OUTPUT_KEPT_AFTER_COLLECTION_MS + 1;
    expect((await w.relay.sweep()).blobsDeleted).toBe(0);
    expect(stored(w)).toHaveLength(1);
  });
});

describe("a relay and its blob store", () => {
  it("carries no images without one: the routes are absent and image kinds are refused at enqueue", async () => {
    const w = await world({ blobs: false });
    const blob = mintBlobId(ONE_BUCKET);
    for (const [endpoint, body] of [
      ["blobs", { direction: "in", bytes: ONE_BUCKET }],
      ["blobs/download", { blob }],
      ["blobs/received", { blobs: [blob] }],
    ] as const) {
      const response = await w.blobPost(endpoint, { jobId: "job-x", ...body });
      expect([endpoint, response.status]).toEqual([endpoint, 404]);
      expect(await response.json()).toEqual({ error: "not-found" });
    }
    for (const kind of ["llm.vision", "llm.image"] as const) {
      const refused = await w.enqueue(w.stubFor(kind));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { message: string }).message).toMatch(
        /carries no images/,
      );
    }
    // Everything else routes as it did.
    expect((await w.enqueue(w.stubFor("llm.chat"))).status).toBe(200);
  });

  it("answers a daemon's blob calls not-found without one, as a relay before them does", async () => {
    const w = await world({ blobs: false });
    const stub = w.stubFor("llm.chat");
    expect((await w.enqueue(stub)).status).toBe(200);
    const job = await w.run(stub.id);
    for (const [endpoint, body] of [
      ["blob-url", { blob: mintBlobId(ONE_BUCKET) }],
      ["blob-slot", { bytes: ONE_BUCKET }],
    ] as const) {
      const response = await w.daemon.signedFetch(endpoint, {
        ...job,
        ...body,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not-found" });
    }
  });

  it("says try again when the store cannot answer, and not why", async () => {
    const w = await world();
    w.blobStore.failing = true;
    const response = await w.blobPost("blobs", {
      jobId: "job-down",
      direction: "in",
      bytes: ONE_BUCKET,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("server-error");
    expect(body.message).not.toMatch(/bucket unreachable/);
  });

  it("serves a store URL once for an upload, and never for the other method", async () => {
    const w = await world();
    const slot = await w.input("job-once", ONE_BUCKET, ONE_BUCKET);
    expect((await w.put(slot.url, ONE_BUCKET)).status).toBe(409);
    expect((await w.get(slot.url)).status).toBe(403);
    expect((await w.get(`${ORIGIN}/relay/blob-store/guess`)).status).toBe(403);
    const late = await w.input("job-late", ONE_BUCKET, 0);
    w.clock.at += 16 * 60_000;
    expect((await w.put(late.url, ONE_BUCKET)).status).toBe(403);
  });
});
