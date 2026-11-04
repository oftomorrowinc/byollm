import {
  BLOB_NONCE_BYTES,
  BLOB_PADDING_BYTES,
  BLOB_TAG_BYTES,
  MAX_IMAGE_BYTES,
  blobObjectBytes,
  decryptBlob,
  encryptBlob,
  sniffImage,
  withinImageCaps,
  type BlobRef,
  type ImageMediaType,
  type SniffedImage,
} from "@byollm/protocol";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Backend } from "./backends/types.js";

/**
 * The daemon's half of images — byollm_021 §2–§6, card 6 of #6933.
 *
 * Bytes come in as encrypted blobs named by references inside the sealed
 * payload, and go out the same way. The crypto, the padding and the sniffing
 * are the protocol's (`blob.ts`), shared with the site so the two ends cannot
 * disagree about what decrypts. This file is the order things happen in on a
 * device: **budget, then download, then open**; and for output, **sniff,
 * then encrypt, then upload**.
 */

/** Mebibytes, to one decimal, for a refusal a person reads. */
function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A teammate's images, charged before anything is downloaded — §3,
 * {@link MUSTS.BLOB_BUDGET_BEFORE_DOWNLOAD} (C051).
 *
 * From the `bytes` each reference declares in the opened payload, which is
 * all this device has fetched so far: the sealed payload, at most 6 MiB of
 * text and references. This charges the declared **plaintext**, as §3 says,
 * not the stored object.
 *
 * The declared sum is not the ceiling on what the job can make this device
 * fetch. Each download stops at `blobObjectBytes(ref.bytes)`, the plaintext
 * padded up to its 256 KiB bucket plus nonce and tag, because that is the
 * only size a stored object can be. So an admitted job can cost up to
 * {@link imageDownloadCeiling}: `maxImageBytes` plus, per reference, one
 * bucket and the 40 bytes of nonce and tag. For eight images under the 16 MiB
 * default, that is about 18 MiB (C051's bound case pins it). Charging the
 * object size instead would refuse a single 16 MiB image at the 16 MiB
 * default.
 *
 * The refusal names the setting and the size the job needed (byollm_013's
 * rule), so the remedy is in the sentence.
 */
export function imageBudgetRefusal(
  refs: readonly BlobRef[],
  maxImageBytes: number,
  configPath = "your config",
): string | undefined {
  const declared = refs.reduce((sum, ref) => sum + ref.bytes, 0);
  if (declared <= maxImageBytes) return undefined;
  return (
    `a teammate's job declares ${mib(declared)} of images and ` +
    `community.maxImageBytes is ${mib(maxImageBytes)} — raise ` +
    `community.maxImageBytes in ${configPath} to at least ` +
    `${String(declared)} to accept it`
  );
}

/**
 * The most a job admitted by {@link imageBudgetRefusal} can make this device
 * download in blob objects: `maxImageBytes + refs × (BLOB_PADDING_BYTES +
 * nonce + tag)`.
 *
 * Each reference declares at least one byte, and padding adds less than one
 * bucket to it, so each object exceeds its declared plaintext by less than
 * `BLOB_PADDING_BYTES + BLOB_NONCE_BYTES + BLOB_TAG_BYTES`. The sum of the
 * declared plaintext is at most `maxImageBytes`, or the job was refused.
 */
export function imageDownloadCeiling(
  refs: number,
  maxImageBytes: number,
): number {
  return (
    maxImageBytes +
    refs * (BLOB_PADDING_BYTES + BLOB_NONCE_BYTES + BLOB_TAG_BYTES)
  );
}

/** How a device moves blob ciphertext: the upstream's two endpoints and a GET or PUT. */
export interface BlobTransport {
  /** A download URL for an input blob, under this job's lease. */
  url(blob: string): Promise<string>;
  /** GET at most `size` bytes; anything over it is cut off and refused. */
  get(
    url: string,
    size: number,
  ): Promise<
    | { readonly ok: true; readonly bytes: Uint8Array }
    | { readonly ok: false; readonly message: string }
  >;
  /** An upload slot for an output object of exactly `bytes`. */
  slot(bytes: number): Promise<{ readonly blob: string; readonly url: string }>;
  put(
    url: string,
    object: Uint8Array,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
}

/** An input image, opened and checked against its reference. */
export interface OpenedImage {
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
}

/**
 * Download and open a job's input images, one at a time, in order.
 *
 * Each download is asked for exactly `blobObjectBytes(ref.bytes)` — the
 * padded size plus nonce and tag, the only size `decryptBlob` will open — so
 * a store holding more than its reference declares costs this device the
 * declared size and no more (C052's daemon half). Then `decryptBlob` refuses
 * the wrong job, blob or direction, a hash mismatch, and a type or size the
 * bytes do not bear out (`BLOB_BOUND_TO_JOB` C049, `MEDIA_VERIFIED` C050 —
 * the device's ends, in `images.test.ts`). Nothing reaches a backend until
 * every image has passed. This is the only way an input blob reaches a
 * backend: nothing is cached, so a retried job downloads and opens again.
 *
 * Sequential on purpose: the first refusal stops the downloads after it.
 */
export async function openInputImages(input: {
  readonly refs: readonly BlobRef[];
  readonly jobId: string;
  readonly transport: BlobTransport;
}): Promise<
  | { readonly ok: true; readonly images: readonly OpenedImage[] }
  | { readonly ok: false; readonly message: string }
> {
  const images: OpenedImage[] = [];
  for (const ref of input.refs) {
    const url = await input.transport.url(ref.blob);
    const got = await input.transport.get(url, blobObjectBytes(ref.bytes));
    if (!got.ok) return got;
    const opened = await decryptBlob({
      object: got.bytes,
      ref,
      jobId: input.jobId,
      direction: "in",
    });
    if (!opened.ok) {
      return {
        ok: false,
        message: `an input image was refused: ${opened.message}`,
      };
    }
    images.push({ mediaType: ref.mediaType, bytes: opened.bytes });
  }
  return { ok: true, images };
}

/**
 * Check, encrypt and upload a backend's images, returning their references.
 *
 * Each image must be a PNG, JPEG or WebP by its magic, within the size and
 * pixel caps, and at most {@link MAX_IMAGE_BYTES} — the backend is untrusted
 * to this device as the device's output is to the site (§4). The blob id is
 * the upstream's, from the slot, because the associated data binds it.
 */
export async function storeOutputImages(input: {
  readonly images: readonly Uint8Array[];
  readonly jobId: string;
  readonly transport: BlobTransport;
}): Promise<
  | { readonly ok: true; readonly refs: readonly BlobRef[] }
  | { readonly ok: false; readonly message: string }
> {
  /* Every image checked before the first upload, so a bad one costs no
     slot. */
  const checked: { plaintext: Uint8Array; sniffed: SniffedImage }[] = [];
  for (const plaintext of input.images) {
    const sniffed = checkOutputImage(plaintext);
    if (!sniffed.ok) return sniffed;
    checked.push({ plaintext, sniffed });
  }
  const refs: BlobRef[] = [];
  for (const { plaintext, sniffed } of checked) {
    const slot = await input.transport.slot(blobObjectBytes(plaintext.length));
    const sealed = await encryptBlob({
      plaintext,
      jobId: input.jobId,
      blobId: slot.blob,
      direction: "out",
    });
    const put = await input.transport.put(slot.url, sealed.object);
    if (!put.ok) return put;
    refs.push({
      blob: slot.blob,
      mediaType: sniffed.mediaType,
      bytes: plaintext.length,
      width: sniffed.width,
      height: sniffed.height,
      sha256: sealed.sha256,
      key: sealed.key,
    });
  }
  return { ok: true, refs };
}

function checkOutputImage(bytes: Uint8Array):
  | {
      readonly ok: true;
      readonly mediaType: ImageMediaType;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly message: string } {
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: `the model made an image of ${mib(bytes.length)}, over the ${mib(MAX_IMAGE_BYTES)} cap`,
    };
  }
  const sniffed = sniffImage(bytes);
  if (sniffed === null) {
    return {
      ok: false,
      message: "the model's image is not a PNG, JPEG or WebP by its bytes",
    };
  }
  if (!withinImageCaps(sniffed)) {
    return {
      ok: false,
      message: `the model's image is ${String(sniffed.width)}×${String(sniffed.height)}, over the pixel caps`,
    };
  }
  return { ok: true, ...sniffed };
}

// -- probes --------------------------------------------------------------------

/**
 * 16×16 solid red, as a PNG — §5's vision probe image. Embedded rather than
 * drawn at run time, so the probe sends the same 79 bytes everywhere.
 */
const RED_SQUARE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==",
  "base64",
);

const VISION_ASK = "What colour is this square? Answer with one word.";

/**
 * - `passes` — the probe proved the effect.
 * - `cannot` — the service answered, and not like that. Held: asking the same
 *   model again will not change it.
 * - `unanswered` — the service did not answer (down, timed out). Not held.
 */
export type ImageProbe =
  | { readonly kind: "passes"; readonly at: number }
  | { readonly kind: "cannot"; readonly why: string; readonly at: number }
  | { readonly kind: "unanswered"; readonly why: string; readonly at: number };

const PROBE_TIMEOUT_MS = 120_000;

/**
 * How long a probe's verdict is reused — §5: "the heartbeat reuses the last
 * result for 24 hours. It never runs per heartbeat."
 */
export const IMAGE_PROBE_REUSE_MS = 24 * 60 * 60 * 1000;

const ImageProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passes"), at: z.number() }).strict(),
  z
    .object({ kind: z.literal("cannot"), why: z.string(), at: z.number() })
    .strict(),
  z
    .object({ kind: z.literal("unanswered"), why: z.string(), at: z.number() })
    .strict(),
]);

/**
 * Where image-probe verdicts are kept, keyed by what was asked.
 *
 * A file, because the image probe is a paid call on a metered backend and
 * three processes ask: the daemon (one runner per pairing), `byollm start`
 * and `byollm services`. Kept in memory alone, each would pay for its own.
 * The key holds the kind, the service, its backend, its address and its
 * model, so changing any of them is a new question and is asked again.
 */
export interface ImageProbeStore {
  get(key: string): Promise<ImageProbe | undefined>;
  set(key: string, verdict: ImageProbe): Promise<void>;
}

export function imageProbeKey(input: {
  readonly kind: string;
  readonly service: string;
  readonly backendId: string;
  readonly baseUrl: string | undefined;
  readonly model: string;
}): string {
  return JSON.stringify([
    input.kind,
    input.service,
    input.backendId,
    input.baseUrl ?? "",
    input.model,
  ]);
}

export function memoryImageProbeStore(): ImageProbeStore {
  const held = new Map<string, ImageProbe>();
  return {
    get: (key) => Promise.resolve(held.get(key)),
    set: (key, verdict) => {
      held.set(key, verdict);
      return Promise.resolve();
    },
  };
}

/**
 * The file store. Unreadable is empty: a lost verdict costs one probe, and a
 * file that will not parse must not stop a daemon from starting.
 */
export function fileImageProbeStore(path: string): ImageProbeStore {
  const read = async (): Promise<Record<string, ImageProbe>> => {
    try {
      const parsed = z
        .record(z.string(), ImageProbeSchema)
        .safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };
  return {
    get: async (key) => (await read())[key],
    set: async (key, verdict) => {
      const all = { ...(await read()), [key]: verdict };
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${String(process.pid)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    },
  };
}

/**
 * Does this service's model read images? — §5, C055.
 *
 * **The effect, not the invocation.** Some model servers drop image parts for
 * a model that cannot see and answer anyway, so a 200 proves nothing. The
 * probe sends a solid red square through the exact request shape a job uses
 * and passes only on "red". A model guessing a colour is wrong four times in
 * five; one answering "blue" is not reading the image, and the reason says
 * so in the model's own word.
 */
export async function probeVision(
  backend: Backend,
  model: string,
  now: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<ImageProbe> {
  if (backend.readImages === undefined) {
    return { kind: "cannot", why: needsHttp(backend, "read images"), at: now };
  }
  const result = await backend.readImages({
    model,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
    signal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_ASK },
          { type: "image", mediaType: "image/png", bytes: RED_SQUARE_PNG },
        ],
      },
    ],
  });
  if (!result.ok) return { kind: "unanswered", why: result.message, at: now };
  const word = firstWord(result.text);
  if (word === "red") return { kind: "passes", at: now };
  return {
    kind: "cannot",
    why:
      `${model} on ${backend.id}: sent an image, the model answered ` +
      `${JSON.stringify(word === "" ? result.text.slice(0, 40) : word)} — ` +
      "it is not reading images",
    at: now,
  };
}

/**
 * Can this service make images? — §5.
 *
 * Asks for one image at the owner's probe size and passes when the bytes are
 * a PNG, JPEG or WebP by their magic. A backend that answers with a URL fails
 * here, in words, before any job reaches it (§6).
 */
export async function probeImages(
  backend: Backend,
  model: string,
  size: string,
  now: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<ImageProbe> {
  if (backend.makeImages === undefined) {
    return { kind: "cannot", why: needsHttp(backend, "make images"), at: now };
  }
  const result = await backend.makeImages({
    model,
    prompt: "A plain red square.",
    size,
    count: 1,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: probeOutputCap(),
    signal,
  });
  if (!result.ok) {
    /* A URL answer is a fact about the backend, not an outage: held. */
    return result.code === "backend-error"
      ? {
          kind: "cannot",
          why: `${model} on ${backend.id}: ${result.message}`,
          at: now,
        }
      : { kind: "unanswered", why: result.message, at: now };
  }
  const [first] = result.images;
  if (first === undefined || sniffImage(first) === null) {
    return {
      kind: "cannot",
      why: `${model} on ${backend.id}: answered with bytes that are not a PNG, JPEG or WebP`,
      at: now,
    };
  }
  return { kind: "passes", at: now };
}

/** One image at the cap, as base64, with room for the JSON around it. */
export function probeOutputCap(count = 1): number {
  return Math.ceil((MAX_IMAGE_BYTES * count * 4) / 3) + 64 * 1024;
}

function needsHttp(backend: Backend, what: string): string {
  return (
    `${backend.id} cannot ${what} — that needs an HTTP backend, such as ` +
    "Ollama, LM Studio or an OpenAI-compatible API"
  );
}

function firstWord(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/^[^a-z]+/, "")
      .split(/[^a-z]/)[0] ?? ""
  );
}
