import { createHmac } from "node:crypto";
import {
  MAX_IMAGES_OUT,
  blobObjectBytes,
  signWith,
  verifyWith,
  type BlobDirection,
  type BlobRef,
  type ImageJobOutcome,
  type JobOutcome,
  type StoredKeys,
} from "@byollm/protocol";
import type { StoredOutcome } from "./records.js";
import type { BlobStore, StoredBlob } from "./store.js";

/**
 * The direct lane's half of byollm_021 §2: blobs in this site's own store.
 *
 * On the direct lane the site *is* the upstream, so the hub's three parties —
 * the site uploading, R2 holding, the hub presigning — are one process and
 * its store. What stays exactly as on the hub is what the parties can see:
 * the store holds ciphertext under a slot and a deletion time, a URL is a
 * short-lived capability for one blob under one lease, and **no key is
 * written anywhere but a sealed envelope** ({@link MUSTS.BLOBS_SEALED}).
 */

/**
 * §2's two deletion clocks. The protocol's, because a relay deletes on the
 * same two and a second statement of either is a lane whose blobs live
 * longer than the privacy page says.
 */
export {
  BLOBS_KEPT_AFTER_DEADLINE_MS,
  OUTPUT_KEPT_AFTER_COLLECTION_MS,
} from "@byollm/protocol";

/** How long a blob URL works once issued. Short: it is a bearer capability. */
export const BLOB_URL_TTL_MS = 5 * 60_000;

/** Where blob URLs are served, under the protocol's mount. */
export const BLOB_URL_SEGMENT = "blobs";

/** What one blob URL lets its bearer do. */
export interface BlobUrlGrant {
  readonly blob: string;
  readonly jobId: string;
  /** The lease it was issued under. A URL dies with its lease. */
  readonly leaseId: string;
  readonly method: "GET" | "PUT";
  readonly expiresAt: number;
}

const URL_CONTEXT = "byollm/v1/blob-url\u0000";

/**
 * Mint a blob URL's token: the grant, signed by this site's identity key.
 *
 * Signed rather than stored, because a site is usually more than one process
 * — a token minted on one instance has to open on whichever instance the
 * `GET` reaches. The domain tag keeps the signature from being presented as
 * anything else this key signs.
 */
export function signBlobUrl(
  siteKeys: Pick<StoredKeys, "identityPrivate">,
  grant: BlobUrlGrant,
): string {
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = signWith(siteKeys, Buffer.from(URL_CONTEXT + body));
  return `${body}.${signature}`;
}

/** Open a token this site signed, or `null` for anything else, expired included. */
export function openBlobUrl(
  identityPublic: string,
  token: string,
  now: number,
): BlobUrlGrant | null {
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined) {
    return null;
  }
  if (!verifyWith(identityPublic, Buffer.from(URL_CONTEXT + body), signature)) {
    return null;
  }
  let grant: unknown;
  try {
    grant = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const g = grant as Partial<BlobUrlGrant> | null;
  if (
    typeof g?.blob !== "string" ||
    typeof g.jobId !== "string" ||
    typeof g.leaseId !== "string" ||
    (g.method !== "GET" && g.method !== "PUT") ||
    typeof g.expiresAt !== "number" ||
    g.expiresAt <= now
  ) {
    return null;
  }
  return g as BlobUrlGrant;
}

/**
 * A 32-byte pad unique to one blob of one job, from this site's own secret.
 *
 * HMAC-SHA-256 keyed by the site's identity secret over a domain tag, the job
 * and the blob. Blob ids are random and never reused, so no pad is used twice.
 */
function padFor(
  siteKeys: Pick<StoredKeys, "identityPrivate">,
  context: string,
  jobId: string,
  blobId: string,
): Buffer {
  return createHmac("sha256", Buffer.from(siteKeys.identityPrivate, "base64"))
    .update(`${context}\u0000${jobId}\u0000${blobId}`)
    .digest();
}

/**
 * An output blob's key as this site keeps it at rest — wrapped, so the store
 * holds nothing that opens the blob.
 *
 * **Why a result's keys need this and a payload's do not.** A payload is
 * stored as an envelope sealed to the site itself, keys and all. A result is
 * opened on arrival — the site is its endpoint — and its outcome is stored so
 * the app can read it later. For a text answer that is the point. For an
 * `llm.image` answer the outcome is a list of references, and a reference
 * holds its blob's key: stored as it arrived, the store would hold both the
 * ciphertext and the key that opens it, which is the one thing
 * {@link MUSTS.BLOBS_SEALED} forbids.
 *
 * So the key is XORed with a pad only this site can compute. Same length, so
 * a reference keeps its shape; no integrity of its own, because the blob's
 * AEAD and its `sha256` already refuse anything a wrong key opens. The same
 * function unwraps.
 */
export function wrapBlobKey(
  siteKeys: Pick<StoredKeys, "identityPrivate">,
  jobId: string,
  blobId: string,
  key: string,
): string {
  const raw = Buffer.from(key, "base64url");
  const pad = padFor(siteKeys, "byollm/v1/blob-key-at-rest", jobId, blobId);
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = (raw[i] ?? 0) ^ (pad[i % pad.length] ?? 0);
  }
  return out.toString("base64url");
}

/**
 * An outcome as this site keeps it: a text answer as sealed, an `llm.image`
 * answer with each reference's key wrapped ({@link wrapBlobKey}).
 *
 * One function for both lanes. The direct lane's store holds the ciphertext
 * too, which is why a bare key may not sit beside it; the cloud lane's does
 * not, and wraps anyway, so a stored reference is one shape wherever the
 * result arrived from and `ByollmApp.images` unwraps it one way.
 */
export function keptOutcome(
  siteKeys: Pick<StoredKeys, "identityPrivate">,
  jobId: string,
  outcome: JobOutcome | ImageJobOutcome,
): StoredOutcome {
  if (!("images" in outcome)) return outcome;
  return {
    outcome: "ok",
    text: outcome.text,
    images: outcome.images.map(({ key, ...ref }) => ({
      ...ref,
      wrappedKey: wrapBlobKey(siteKeys, jobId, ref.blob, key),
    })),
  };
}

/**
 * Read a body, refusing one longer than `limit` — `null` then.
 *
 * Counted as it arrives rather than after: a body is whatever the far end
 * chose to send, and neither an upload under a slot nor a download against
 * a reference may make this process hold more than the size it was told.
 */
export async function readAtMost(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The ids an `llm.image` job's output slots may take under one lease.
 *
 * {@link MAX_IMAGES_OUT} of them, derived from the job and the lease, so a
 * device holding a lease can be issued at most that many slots without the
 * store having to count rows: the next slot is the first of these ids not
 * already taken. Derived from the site's secret, so nobody else can predict
 * one — not that an id opens anything; the URL is the capability.
 */
export function outputBlobIds(
  siteKeys: Pick<StoredKeys, "identityPrivate">,
  jobId: string,
  leaseId: string,
): string[] {
  return Array.from({ length: MAX_IMAGES_OUT }, (_, n) =>
    padFor(
      siteKeys,
      "byollm/v1/output-slot",
      jobId,
      `${leaseId}\u0000${String(n)}`,
    )
      .subarray(0, 16)
      .toString("base64url"),
  );
}

/**
 * Why a referenced blob may not be used, or `null` when it may.
 *
 * **The size check** ({@link MUSTS.BLOB_BUDGET_BEFORE_DOWNLOAD}'s last
 * clause): the object must be stored, belong to this job and this
 * direction, be exactly the size its slot was issued for, and the slot must
 * be the size the reference declares. The upstream reads the stored object's
 * size rather than trusting the slot — on the hub because R2's enforcement
 * of a signed `Content-Length` is Cloudflare's behaviour and not ours, here
 * because an uploader is whoever held the slot.
 *
 * Run before a job is offered (its input blobs) and before a result is
 * accepted (its output blobs).
 */
export async function blobFault(
  store: BlobStore,
  input: {
    readonly jobId: string;
    readonly direction: BlobDirection;
    readonly ref: Pick<BlobRef, "blob" | "bytes">;
    readonly now: number;
  },
): Promise<string | null> {
  const blob = await store.getBlob(input.ref.blob);
  if (
    blob?.jobId !== input.jobId ||
    blob.direction !== input.direction ||
    blob.deleteAt <= input.now
  ) {
    return `blob ${input.ref.blob} is not one of this job's ${input.direction === "in" ? "inputs" : "outputs"}`;
  }
  if (blob.data === null) {
    return `blob ${input.ref.blob} was never uploaded`;
  }
  if (
    blob.data.length !== blob.slotBytes ||
    blob.slotBytes !== blobObjectBytes(input.ref.bytes)
  ) {
    return `blob ${input.ref.blob} is not the size its slot was issued for`;
  }
  return null;
}

/** Whether a stored blob may be served to a bearer of `grant`. */
export function servable(
  blob: StoredBlob,
  grant: BlobUrlGrant,
  now: number,
): boolean {
  return (
    blob.jobId === grant.jobId &&
    blob.deleteAt > now &&
    (grant.method === "GET"
      ? blob.direction === "in" && blob.data !== null
      : blob.direction === "out" && blob.data === null)
  );
}
