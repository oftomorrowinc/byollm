import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOB_PADDING_BYTES,
  ImageSealedOutcome,
  MAX_IMAGES_IN,
  SealedOutcome,
  blobObjectBytes,
  decryptBlob,
  encryptBlob,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sha256Hex,
  signRequest,
  type BlobRef,
  type SealedEnvelope,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Backend,
  BackendRequest,
  BackendResult,
  ImageRequest,
  ImageResult,
  VisionRequest,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { imageBudgetRefusal, imageDownloadCeiling } from "./images.js";
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp, testControlPlane } from "./test-support.js";

/**
 * The daemon's half of images, end to end — byollm_021, card 6 of #6933.
 *
 * Real sealed payloads, real encrypted blobs (the protocol's own
 * `encryptBlob`, the site's encoder), a fake upstream that counts every blob
 * request, and a backend double. The checks are §10's:
 *
 * - C051 a teammate's images are charged before any download;
 * - C052 a download stops at its declared size (and `client.test`-level below);
 * - C055 vision is detected by its effect, not by a 200;
 * - C056 is the http-class corpus (`test/adversarial/http-class.test.ts`) —
 *   the URL a backend returns is never fetched;
 * - C058 neither kind is advertised on a process backend.
 */

const NOW = Date.now();
const SITE_KEYS = generateKeys(NOW);
const SITE_ID = keyId(publicIdentityOf(SITE_KEYS).identity);
const DEVICE_KEYS = generateKeys(NOW);
const SIGNER_KEYS = generateKeys(NOW);
const SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(SIGNER_KEYS, input).signature,
};
const plane = testControlPlane(NOW);
const MiB = 1024 * 1024;

/** 16×16 solid red — the same bytes the probe embeds. */
const RED_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** What the model double saw, and how often it was asked. */
interface Seen {
  calls: number;
  probes: number;
  images: Uint8Array[];
  made: number;
}

class ImageBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  constructor(
    readonly seen: Seen,
    readonly answer: (images: Uint8Array[]) => string = (images) =>
      images.length > 0 &&
      sha256Hex(images[0] ?? new Uint8Array()) === sha256Hex(RED_PNG)
        ? "Red."
        : "Blue.",
    readonly makes: (request: ImageRequest) => ImageResult = () => ({
      ok: true,
      images: [RED_PNG],
      text: "a red square",
      durationMs: 1,
    }),
  ) {}
  health(): Promise<{ healthy: boolean; models: string[] }> {
    // No model list: the server serves whatever it was given.
    return Promise.resolve({ healthy: true, models: [] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    this.seen.calls += 1;
    return Promise.resolve({ ok: true, text: "text", durationMs: 1 });
  }
  readImages(request: VisionRequest): Promise<BackendResult> {
    /* The probe is a call too, but not the job's: counted apart, so "the
       model was never asked" means the job never reached it. */
    const probe = JSON.stringify(request.messages).includes(
      "What colour is this square?",
    );
    if (probe) this.seen.probes += 1;
    else this.seen.calls += 1;
    const images = request.messages.flatMap((turn) =>
      typeof turn.content === "string"
        ? []
        : turn.content.flatMap((part) =>
            part.type === "image" ? [part.bytes] : [],
          ),
    );
    if (!probe) this.seen.images.push(...images);
    return Promise.resolve({
      ok: true,
      text: this.answer(images),
      durationMs: 1,
      stop: "end" as const,
    });
  }
  makeImages(request: ImageRequest): Promise<ImageResult> {
    if (request.prompt === "A plain red square.") this.seen.probes += 1;
    else this.seen.made += 1;
    return Promise.resolve(this.makes(request));
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-images-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** A real input blob, as the site's SDK would make it. */
async function inputBlob(
  jobId: string,
  blob: string,
  plaintext: Uint8Array,
): Promise<{ ref: BlobRef; object: Uint8Array }> {
  const sealed = await encryptBlob({
    plaintext,
    jobId,
    blobId: blob,
    direction: "in",
  });
  return {
    object: sealed.object,
    ref: {
      blob,
      mediaType: "image/png",
      bytes: plaintext.length,
      width: 16,
      height: 16,
      sha256: sealed.sha256,
      key: sealed.key,
    },
  };
}

/** A reference that declares `bytes`, for a blob nobody will ever fetch. */
function declaredRef(blob: string, bytes: number): BlobRef {
  return {
    blob,
    mediaType: "image/png",
    bytes,
    width: 1024,
    height: 1024,
    sha256: "0".repeat(64),
    key: "A".repeat(43),
  };
}

interface Harness {
  readonly cycle: () => Promise<void>;
  readonly refusals: string[];
  readonly released: { jobId: string; reason: string }[];
  readonly blobUrlCalls: string[];
  readonly blobGets: string[];
  readonly slots: number[];
  readonly puts: Map<string, Uint8Array>;
  readonly result: () => Promise<unknown>;
  readonly ingress: IngressLog;
  readonly runner: Runner;
}

async function harness(input: {
  kind: "llm.vision" | "llm.image";
  owner: string;
  payload: unknown;
  /** Blob id → the bytes the store holds under it. */
  store?: Map<string, Uint8Array>;
  backend: Backend;
  service?: Record<string, unknown>;
  community?: Record<string, unknown>;
}): Promise<Harness> {
  const jobId = "job_1";
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: [input.kind],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "team",
          ...input.service,
        },
      },
      ...(input.community === undefined ? {} : { community: input.community }),
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), {
    maxJobsPerHour: 100,
    maxJobsPerDay: 100,
    maxWallClockMs: 60_000,
    maxOutputBytes: 1_000_000,
    maxPayloadChars: 100_000,
  });
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(NOW);
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });
  const refusals: string[] = [];
  const released: { jobId: string; reason: string }[] = [];
  const blobUrlCalls: string[] = [];
  const blobGets: string[] = [];
  const slots: number[] = [];
  const puts = new Map<string, Uint8Array>();
  let resultEnvelope: SealedEnvelope | undefined;
  const settled = { yet: false };
  const store = input.store ?? new Map<string, Uint8Array>();

  const job = {
    id: jobId,
    kind: input.kind,
    audience: "team",
    owner: input.owner,
    site: SITE_ID,
    sizeClass: "small",
    streaming: false,
    deadlineAt: NOW + 60_000,
    lease: {
      id: "lease_1",
      runnerId: "runner_1",
      expiresAt: 4_000_000_000_000,
    },
    grant: plane.sign({
      jobId,
      user: input.owner,
      site: SITE_ID,
      service: "primary",
      kind: input.kind,
    }),
  };
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );

  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: async (request, init) => {
        const url = String(request instanceof Request ? request.url : request);
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        if (url.startsWith("https://blobs.test/")) {
          const id = url.slice("https://blobs.test/".length);
          if (init?.method === "PUT") {
            puts.set(id, new Uint8Array(init.body as Uint8Array));
            return new Response(null, { status: 200 });
          }
          blobGets.push(id);
          const bytes = store.get(id);
          return bytes === undefined
            ? new Response(null, { status: 404 })
            : new Response(bytes);
        }
        if (url.endsWith("/fetch")) {
          const envelope = await seal({
            plaintext: JSON.stringify(input.payload),
            senderKeys: SITE_KEYS,
            recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
            context: {
              jobId,
              senderKeyId: SITE_ID,
              recipientKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
              deadlineAt: NOW + 3_600_000,
              direction: "payload",
            },
          });
          return json({ envelope });
        }
        if (url.endsWith("/blob-url")) {
          blobUrlCalls.push(String(body["blob"]));
          return json({
            url: `https://blobs.test/${String(body["blob"])}`,
            expiresAt: NOW + 300_000,
          });
        }
        if (url.endsWith("/blob-slot")) {
          slots.push(Number(body["bytes"]));
          const blob = `out${String(slots.length)}`;
          return json({
            blob,
            url: `https://blobs.test/${blob}`,
            expiresAt: NOW + 300_000,
          });
        }
        if (url.endsWith("/result")) {
          resultEnvelope = body["envelope"] as SealedEnvelope;
          return json({ accepted: true });
        }
        if (url.endsWith("/release")) {
          for (const lease of body["leases"] as { jobId: string }[]) {
            released.push({
              jobId: lease.jobId,
              reason: String(body["reason"]),
            });
          }
        }
        if (url.endsWith("/claim"))
          return json({ jobs: [job], leaseMs: 60_000 });
        return json({
          sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime: NOW,
        });
      },
    }),
    runnerId: "runner_1",
    identity: {
      keys: () => Promise.resolve(DEVICE_KEYS),
      sites: new Map([[SITE_ID, publicIdentityOf(SITE_KEYS)]]),
    },
    owner: "me",
    daemonVersion: "0.0.0",
    controlPlanePublic: plane.controlPlanePublic,
    loaded,
    budgets,
    spend,
    ingress,
    now: () => NOW,
    onEvent: (event) => {
      if (event.type === "refused") refusals.push(event.reason);
      if (
        event.type === "finished" ||
        event.type === "refused" ||
        event.type === "error"
      ) {
        settled.yet = true;
      }
    },
    backendFactory: () => input.backend,
  });

  const cycle = async () => {
    settled.yet = false;
    await runner.tick();
    const deadline = Date.now() + 10_000;
    const done = () => settled.yet;
    while (!done() && Date.now() < deadline) {
      await new Promise((wake) => setTimeout(wake, 5));
    }
    if (!done()) throw new Error("the job never reached an end");
    // The result post follows the finished event.
    await new Promise((wake) => setTimeout(wake, 20));
  };

  const result = async () => {
    if (resultEnvelope === undefined) return undefined;
    const opened = await open({
      envelope: resultEnvelope,
      recipientKeys: SITE_KEYS,
      senderIdentityPublic: publicIdentityOf(DEVICE_KEYS).identity,
      expected: {
        jobId,
        senderKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
        recipientKeyId: SITE_ID,
        direction: "result",
      },
    });
    if (!opened.ok) throw new Error(`result did not open: ${opened.reason}`);
    return JSON.parse(opened.plaintext) as unknown;
  };

  return {
    cycle,
    refusals,
    released,
    blobUrlCalls,
    blobGets,
    slots,
    puts,
    result,
    ingress,
    runner,
  };
}

const visionPayload = (refs: readonly BlobRef[]) => ({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in these?" },
        ...refs.map((image) => ({ type: "image", image })),
      ],
    },
  ],
});

const seen = (): Seen => ({ calls: 0, probes: 0, images: [], made: 0 });

describe("llm.vision, end to end", () => {
  it("opens the site's blobs and hands the model exactly their bytes", async () => {
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload([blob.ref]),
      store: new Map([["in1", blob.object]]),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.calls).toBe(1);
    expect(model.images).toHaveLength(1);
    expect(
      Buffer.from(model.images[0] ?? []).equals(Buffer.from(RED_PNG)),
    ).toBe(true);
    const sealed = SealedOutcome.parse(await h.result());
    expect(sealed.outcome).toMatchObject({ outcome: "ok", text: "Red." });
  });

  it("refuses a blob opened under another job, and the model sees nothing", async () => {
    /* A blob sealed for job_2, offered as
       job_1's. */
    const blob = await inputBlob("job_2", "in1", RED_PNG);
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload([blob.ref]),
      store: new Map([["in1", blob.object]]),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.calls).toBe(0);
    expect(SealedOutcome.parse(await h.result()).outcome).toMatchObject({
      outcome: "error",
      code: "image_refused",
      retryable: false,
    });
  });
});

/**
 * Run a vision job for `job_1` whose payload names `refs` and whose store
 * holds `store`, and hold it to §10's "refused before the backend": the
 * model was never asked and saw no byte, and the site was told
 * `image_refused`, and the device's log says `why`. The reason is asserted so a
 * refusal for some other cause (a missing blob, a parse failure) cannot
 * stand in for the check under test.
 */
async function refusedBeforeTheBackend(
  refs: readonly BlobRef[],
  store: Map<string, Uint8Array>,
  why: RegExp,
): Promise<Harness> {
  const model = seen();
  const h = await harness({
    kind: "llm.vision",
    owner: "me",
    payload: visionPayload(refs),
    store,
    backend: new ImageBackend(model),
  });
  await h.cycle();
  expect(model.calls, "the model was asked").toBe(0);
  expect(model.images, "the model saw bytes").toEqual([]);
  const outcome = SealedOutcome.parse(await h.result()).outcome;
  expect(outcome).toMatchObject({
    outcome: "error",
    code: "image_refused",
    retryable: false,
  });
  /* The site hears only `image_refused`; the device's own log keeps why. */
  const logged = (await h.ingress.read()).filter((e) => e.type === "outcome");
  expect(logged).toHaveLength(1);
  expect(JSON.stringify(logged[0])).toMatch(why);
  return h;
}

/** 16×16 baseline JPEG header, SOF0 first: enough for the sniffer to measure. */
const JPEG_16 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

/** An input blob of `plaintext` that declares itself a 16×16 PNG regardless. */
async function declaredPng(
  blob: string,
  plaintext: Uint8Array,
): Promise<{ ref: BlobRef; object: Uint8Array }> {
  return inputBlob("job_1", blob, plaintext);
}

describe("C049 — a blob is bound to its job, its id and its direction, on the device [BLOB_BOUND_TO_JOB]", () => {
  /* byollm_021 §10 row 2, the device's end. The site's end is
     packages/server/src/blobs.test.ts. Each blob below is sealed by the
     protocol's own encryptBlob — the site's encoder — and opened by the
     daemon's shipped path (Runner → openInputImages → decryptBlob). */

  it("control: an honest blob reaches the model, so the refusals below are about the blob", async () => {
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload([blob.ref]),
      store: new Map([["in1", blob.object]]),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.calls).toBe(1);
    expect(model.images).toHaveLength(1);
  });

  it("refuses another job's blob, named by its own id and key", async () => {
    /* Two jobs' blob ids swapped: job_1's payload names job_2's blob. */
    const theirs = await inputBlob("job_2", "in2", RED_PNG);
    await refusedBeforeTheBackend(
      [theirs.ref],
      new Map([["in2", theirs.object]]),
      /did not decrypt/,
    );
  });

  it("refuses two of this job's blobs stored under each other's ids", async () => {
    const first = await inputBlob("job_1", "in1", RED_PNG);
    const second = await inputBlob("job_1", "in2", RED_PNG);
    /* The references keep their own keys; the store swapped the objects. */
    await refusedBeforeTheBackend(
      [
        { ...first.ref, key: second.ref.key },
        { ...second.ref, key: first.ref.key },
      ],
      new Map([
        ["in1", second.object],
        ["in2", first.object],
      ]),
      /did not decrypt/,
    );
  });

  it("refuses an output passed off as an input", async () => {
    const sealed = await encryptBlob({
      plaintext: RED_PNG,
      jobId: "job_1",
      blobId: "in1",
      direction: "out",
    });
    const { ref } = await inputBlob("job_1", "in1", RED_PNG);
    await refusedBeforeTheBackend(
      [{ ...ref, key: sealed.key }],
      new Map([["in1", sealed.object]]),
      /did not decrypt/,
    );
  });

  it("refuses a blob with one byte flipped in the store", async () => {
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    const flipped = new Uint8Array(blob.object);
    const at = 24 + 10; // past the nonce, inside the ciphertext
    flipped[at] = (flipped[at] ?? 0) ^ 0x01;
    await refusedBeforeTheBackend(
      [blob.ref],
      new Map([["in1", flipped]]),
      /did not decrypt/,
    );
  });

  it("refuses a blob whose plaintext is not the one its reference hashes", async () => {
    /* Sealed honestly for this job, id and direction, so it decrypts: only
       the hash is wrong. */
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    await refusedBeforeTheBackend(
      [{ ...blob.ref, sha256: sha256Hex(JPEG_16) }],
      new Map([["in1", blob.object]]),
      /does not match its reference/,
    );
  });

  it("refuses the job when only its second input is bad, and the good first one reaches nothing", async () => {
    /* The red-team's "a second input on the same job": the check is per
       blob, and the backend call waits for all of them. */
    const good = await inputBlob("job_1", "in1", RED_PNG);
    const theirs = await inputBlob("job_2", "in2", RED_PNG);
    const h = await refusedBeforeTheBackend(
      [good.ref, theirs.ref],
      new Map([
        ["in1", good.object],
        ["in2", theirs.object],
      ]),
      /did not decrypt/,
    );
    expect(h.blobGets).toEqual(["in1", "in2"]);
  });
});

describe("C050 — an input image is the type and size it declares, on the device [MEDIA_VERIFIED]", () => {
  /* byollm_021 §10 row 3, the device's end: "each one refused; backend saw
     nothing". Each blob is sealed honestly for this job and its hash is its
     plaintext's, so decrypting and hashing pass and only the media check is
     left to refuse it. */

  it("refuses a PNG declared over JPEG bytes", async () => {
    const blob = await declaredPng("in1", JPEG_16);
    await refusedBeforeTheBackend(
      [blob.ref],
      new Map([["in1", blob.object]]),
      /the bytes are not image\/png \(they are image\/jpeg\)/,
    );
  });

  it("refuses an SVG", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
        "<script>alert(1)</script></svg>",
    );
    const blob = await declaredPng("in1", svg);
    await refusedBeforeTheBackend(
      [blob.ref],
      new Map([["in1", blob.object]]),
      /the bytes are not image\/png"/,
    );
  });

  it("refuses a 50,000 × 50,000 PNG header from the header, declared as 16 × 16", async () => {
    const bomb = new Uint8Array(RED_PNG);
    const view = new DataView(bomb.buffer, bomb.byteOffset);
    view.setUint32(16, 50_000);
    view.setUint32(20, 50_000);
    const blob = await declaredPng("in1", bomb);
    await refusedBeforeTheBackend(
      [blob.ref],
      new Map([["in1", blob.object]]),
      /dimensions are not the declared ones, or are over the caps/,
    );
  });

  it("refuses a reference that declares 50,000 × 50,000 before downloading anything", async () => {
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload([{ ...blob.ref, width: 50_000, height: 50_000 }]),
      store: new Map([["in1", blob.object]]),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.calls).toBe(0);
    expect(h.blobGets).toEqual([]);
  });
});

describe("C051 — a teammate's images are budgeted before they are downloaded [BLOB_BUDGET_BEFORE_DOWNLOAD]", () => {
  /* §10 row 4: 3 × 10 MiB against the 16 MiB default. */
  const refs = [
    declaredRef("a", 10 * MiB),
    declaredRef("b", 10 * MiB),
    declaredRef("c", 10 * MiB),
  ];

  it("is refused with zero blob downloads, and the model is never asked", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "a-teammate",
      payload: visionPayload(refs),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(h.blobUrlCalls, "a download URL was asked for").toEqual([]);
    expect(h.blobGets, "a blob was downloaded").toEqual([]);
    expect(model.calls).toBe(0);
    expect(h.refusals).toHaveLength(1);
    /* Names the setting and the size the job needed (byollm_013's rule). */
    expect(h.refusals[0]).toContain("community.maxImageBytes");
    expect(h.refusals[0]).toContain(String(30 * MiB));
    expect(h.released).toEqual([{ jobId: "job_1", reason: "refused" }]);
    const outcomes = (await h.ingress.read()).filter(
      (e) => e.type === "outcome",
    );
    expect(outcomes).toMatchObject([
      { outcome: "refused", brake: "image-bytes" },
    ]);
  });

  it("is admitted when the owner raises community.maxImageBytes", async () => {
    const h = await harness({
      kind: "llm.vision",
      owner: "a-teammate",
      payload: visionPayload(refs),
      backend: new ImageBackend(seen()),
      community: { maxImageBytes: 30 * MiB },
    });
    await h.cycle();
    /* Past the budget, it asks for its first blob — the fake store has none,
       so it ends there. The budget is what moved, and nothing else. */
    expect(h.refusals).toEqual([]);
    expect(h.blobUrlCalls).toEqual(["a"]);
  });

  it("is not charged on the owner's own job", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload(refs),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    /* The owner's job gets past the budget and asks for its first blob; the
       fake store has none, so it ends there, refused by the store. */
    expect(h.refusals).toEqual([]);
    expect(h.blobUrlCalls).toEqual(["a"]);
  });
});

describe("C051's bound — what an admitted teammate's job can make this device download [BLOB_BUDGET_BEFORE_DOWNLOAD]", () => {
  /* Owl #56114: the budget charges declared plaintext, and each GET is
     allowed the padded object. The worst case puts every image one byte
     into a fresh 256 KiB bucket: seven of 2 MiB + 1 and one shaved so the
     declared sum is exactly the 16 MiB default, which is admitted. */
  const MAX = 16 * MiB;
  const sizes = [
    ...Array.from({ length: MAX_IMAGES_IN - 1 }, () => 2 * MiB + 1),
    2 * MiB - (MAX_IMAGES_IN - 1),
  ];

  /** RED_PNG, zero-filled to `bytes`: a real image the site could send. */
  const imageOf = (bytes: number) => {
    const plaintext = new Uint8Array(bytes);
    plaintext.set(RED_PNG);
    return plaintext;
  };

  it("is admitted, downloads more than maxImageBytes, and never more than imageDownloadCeiling", async () => {
    expect(MAX_IMAGES_IN).toBe(8);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(MAX);
    const blobs = await Promise.all(
      sizes.map((bytes, i) =>
        inputBlob("job_1", `in${String(i)}`, imageOf(bytes)),
      ),
    );
    const store = new Map(blobs.map((b) => [b.ref.blob, b.object]));
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "a-teammate",
      payload: visionPayload(blobs.map((b) => b.ref)),
      store,
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(h.refusals).toEqual([]);
    expect(h.blobGets).toHaveLength(MAX_IMAGES_IN);
    const downloaded = h.blobGets.reduce(
      (sum, id) => sum + (store.get(id)?.length ?? 0),
      0,
    );
    /* The overage is real — about 2 MiB at the default — and it is what
       the comments on imageBudgetRefusal and the runner's admission say. */
    expect(downloaded).toBeGreaterThan(MAX + 7 * BLOB_PADDING_BYTES);
    expect(downloaded).toBeLessThanOrEqual(
      imageDownloadCeiling(MAX_IMAGES_IN, MAX),
    );
    expect(imageDownloadCeiling(MAX_IMAGES_IN, MAX)).toBe(
      MAX + MAX_IMAGES_IN * (BLOB_PADDING_BYTES + 40),
    );
    /* Seals and opens eight ~2 MiB blobs: about 4 s on an idle machine,
       so the 5 s unit default timed it out under a full `pnpm verify`
       (landing of #8409). */
  }, 30_000);

  it("holds for every admitted split: no admitted refs exceed the ceiling", () => {
    /* The ceiling is per reference, so the worst shapes are 1..8 refs each
       one byte into a bucket, plus the remainder. */
    for (let n = 1; n <= MAX_IMAGES_IN; n++) {
      for (const each of [1, BLOB_PADDING_BYTES + 1, 2 * MiB + 1, MAX / n]) {
        const refs = Array.from({ length: n - 1 }, () => Math.floor(each));
        const rest = MAX - refs.reduce((a, b) => a + b, 0);
        if (rest < 1) continue;
        refs.push(rest);
        if (
          imageBudgetRefusal(
            refs.map((b, i) => declaredRef(String(i), b)),
            MAX,
          ) !== undefined
        )
          continue;
        const objects = refs.reduce((sum, b) => sum + blobObjectBytes(b), 0);
        expect(
          objects,
          `${String(n)} refs of ${String(each)}`,
        ).toBeLessThanOrEqual(imageDownloadCeiling(n, MAX));
      }
    }
  });
});

describe("C052 — a blob larger than declared [BLOB_BUDGET_BEFORE_DOWNLOAD]", () => {
  /* §10 row 5: 12 MiB stored under a reference declaring 2 MiB. */
  const declared = blobObjectBytes(2 * MiB);
  const CHUNK = 64 * 1024;

  /** A store that streams `total` bytes, counting what the client pulled. */
  function swollenStore(total: number, headers: Record<string, string> = {}) {
    const pulled = { bytes: 0 };
    const client = new ProtocolClient({
      origin: "https://app.test",
      fetch: () => {
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (pulled.bytes >= total) {
                controller.close();
                return;
              }
              const n = Math.min(CHUNK, total - pulled.bytes);
              pulled.bytes += n;
              controller.enqueue(new Uint8Array(n));
            },
          },
          { highWaterMark: 0 },
        );
        return Promise.resolve(new Response(body, { headers }));
      },
    });
    return { client, pulled };
  }

  it("stops the download at the declared size and refuses it", async () => {
    const { client, pulled } = swollenStore(12 * MiB);
    const got = await client.getBlob("https://blobs.test/x", declared);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain("stopped at the declared size");
    /* At most the declared size and the one chunk that crossed it — never
       the 12 MiB. */
    expect(pulled.bytes).toBeLessThanOrEqual(declared + CHUNK);
  });

  it("refuses on a Content-Length over the declared size, before reading", async () => {
    const { client, pulled } = swollenStore(12 * MiB, {
      "content-length": String(12 * MiB),
    });
    const got = await client.getBlob("https://blobs.test/x", declared);
    expect(got.ok).toBe(false);
    expect(pulled.bytes).toBeLessThanOrEqual(CHUNK);
  });

  it("refuses a blob shorter than declared", async () => {
    const { client } = swollenStore(declared - 1);
    expect((await client.getBlob("https://blobs.test/x", declared)).ok).toBe(
      false,
    );
  });

  it("takes a blob of exactly the declared size", async () => {
    const { client } = swollenStore(declared);
    expect((await client.getBlob("https://blobs.test/x", declared)).ok).toBe(
      true,
    );
  });

  it("is refused, and the model sees nothing", async () => {
    /* Declared as one real image; stored as that object plus 12 MiB. */
    const blob = await inputBlob("job_1", "in1", RED_PNG);
    const swollen = new Uint8Array(blob.object.length + 12 * MiB);
    swollen.set(blob.object);
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: visionPayload([blob.ref]),
      store: new Map([["in1", swollen]]),
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.calls).toBe(0);
    expect(SealedOutcome.parse(await h.result()).outcome).toMatchObject({
      outcome: "error",
      code: "image_refused",
    });
  });
});

describe("llm.image, end to end", () => {
  it("uploads the images encrypted and answers with references the site can open", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.image",
      owner: "me",
      payload: { prompt: "a red square" },
      backend: new ImageBackend(model),
    });
    await h.cycle();
    expect(model.made).toBe(1);
    expect(h.slots).toEqual([blobObjectBytes(RED_PNG.length)]);
    const sealed = ImageSealedOutcome.parse(await h.result());
    expect(sealed.outcome.outcome).toBe("ok");
    if (sealed.outcome.outcome !== "ok") return;
    const [ref] = sealed.outcome.images;
    expect(ref).toMatchObject({
      blob: "out1",
      mediaType: "image/png",
      width: 16,
      height: 16,
    });
    const object = h.puts.get("out1");
    expect(object, "nothing was uploaded").toBeDefined();
    /* The store holds ciphertext: the PNG's bytes appear nowhere in it. */
    expect(Buffer.from(object ?? []).includes(Buffer.from(RED_PNG))).toBe(
      false,
    );
    if (ref === undefined || object === undefined) return;
    const opened = await decryptBlob({
      object,
      ref,
      jobId: "job_1",
      direction: "out",
    });
    expect(opened.ok).toBe(true);
  });

  it("errors on bytes that are not an image, and uploads nothing", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.image",
      owner: "me",
      payload: { prompt: "a red square" },
      /* The probe gets a real PNG, so the kind is advertised; the job gets
         a document wearing an image's place. */
      backend: new ImageBackend(model, undefined, (request) => ({
        ok: true,
        images: [
          request.prompt === "A plain red square."
            ? RED_PNG
            : new TextEncoder().encode("<svg onload='x'/>"),
        ],
        text: "",
        durationMs: 1,
      })),
    });
    await h.cycle();
    expect(h.slots).toEqual([]);
    expect(ImageSealedOutcome.parse(await h.result()).outcome.outcome).toBe(
      "error",
    );
  });

  it("clamps count to the owner's maxImagesPerJob", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.image",
      owner: "me",
      payload: { prompt: "a red square", count: 4 },
      backend: new ImageBackend(model, undefined, () => ({
        ok: true,
        images: [RED_PNG, RED_PNG, RED_PNG, RED_PNG],
        text: "",
        durationMs: 1,
      })),
      service: { images: { maxImagesPerJob: 2 } },
    });
    await h.cycle();
    expect(h.slots).toHaveLength(2);
  });
});

describe("C055 — vision is detected by its effect, not by a 200 [CAPABILITY_IS_DETECTED]", () => {
  it("an echo backend that ignores the image and answers 'blue' is not advertised, and says why", async () => {
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: {},
      backend: new ImageBackend(seen(), () => "Blue."),
    });
    const capabilities = await h.runner.detectCapabilities();
    expect(capabilities.map((c) => c.kind)).not.toContain("llm.vision");
    const verdict = h.runner.imageProbes.get("primary llm.vision");
    expect(verdict?.kind).toBe("cannot");
    expect(verdict?.kind === "cannot" ? verdict.why : "").toContain(
      'the model answered "blue" — it is not reading images',
    );
  });

  it("a backend that reads the square is advertised", async () => {
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: {},
      backend: new ImageBackend(seen()),
    });
    const capabilities = await h.runner.detectCapabilities();
    expect(capabilities.map((c) => c.kind)).toContain("llm.vision");
  });

  it("is asked once, not every heartbeat", async () => {
    const model = seen();
    const h = await harness({
      kind: "llm.vision",
      owner: "me",
      payload: {},
      backend: new ImageBackend(model),
    });
    await h.runner.detectCapabilities();
    await h.runner.detectCapabilities();
    expect(model.probes).toBe(1);
  });

  it("an image backend that returns no image is not advertised", async () => {
    const h = await harness({
      kind: "llm.image",
      owner: "me",
      payload: {},
      backend: new ImageBackend(seen(), undefined, () => ({
        ok: false,
        code: "backend-error",
        message: "the model server answered with a URL instead of image bytes",
        durationMs: 1,
      })),
    });
    const capabilities = await h.runner.detectCapabilities();
    expect(capabilities.map((c) => c.kind)).not.toContain("llm.image");
  });
});

describe("C058 — no images on a process backend (byollm_021 §10)", () => {
  it.each(["claude-cli", "codex-cli"] as const)(
    "a %s service listing llm.vision and llm.image advertises neither, even with a backend claiming both",
    async (type) => {
      const loaded = resolveConfig(
        DaemonConfig.parse({
          services: {
            cli: {
              type,
              model: "default",
              kinds: ["llm.chat", "llm.vision", "llm.image"],
            },
          },
        }),
      );
      expect(loaded.problems.map((p) => p.message)).toEqual([
        expect.stringContaining("llm.vision needs an HTTP backend"),
        expect.stringContaining("llm.image needs an HTTP backend"),
      ]);
      const budgets = new Budgets(join(dir, "b.json"), {
        maxJobsPerHour: 1,
        maxJobsPerDay: 1,
        maxWallClockMs: 1,
        maxOutputBytes: 1,
        maxPayloadChars: 1,
      });
      await budgets.load(NOW);
      const spend = new SpendLedger(join(dir, "s.json"));
      await spend.load(NOW);
      const runner = new Runner({
        client: new ProtocolClient({ origin: "https://unused.invalid" }),
        runnerId: "local",
        owner: "local",
        daemonVersion: "0.0.0",
        loaded,
        budgets,
        spend,
        ingress: new IngressLog({
          path: join(dir, "i.log"),
          communityPromptDays: 7,
          keepSelfPrompts: true,
        }),
        /* The hostile case: a backend double that WOULD read and make
           images. The kind is refused by the route, not by the adapter. */
        backendFactory: () => new ImageBackend(seen()),
      });
      const capabilities = await runner.detectCapabilities();
      expect(capabilities.map((c) => c.kind)).toEqual(["llm.chat"]);
    },
  );
});
