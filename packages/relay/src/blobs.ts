import { randomBytes } from "node:crypto";
import {
  BLOB_NONCE_BYTES,
  BLOB_PADDING_BYTES,
  BLOB_TAG_BYTES,
  BLOBS_KEPT_AFTER_DEADLINE_MS,
  ENVELOPE_MAX_AGE_MS,
  MAX_BLOB_OBJECT_BYTES,
  MAX_IMAGES_IN,
  MAX_IMAGES_OUT,
  OUTPUT_KEPT_AFTER_COLLECTION_MS,
  isBlobObjectSize,
  type BlobDirection,
} from "@byollm/protocol";

/**
 * The relay's half of byollm_021 §2: blobs by reference, on the cloud lane.
 *
 * Ruled on #7875 (rule 34), under #6933. A site uploads each input image
 * straight to object storage through a slot this relay issues, a device
 * holding the job's lease downloads it through a URL this relay issues, and
 * the reverse for an `llm.image` job's outputs. **The bytes never pass
 * through this process**: it issues short-lived URLs, reads sizes, and
 * deletes.
 *
 * It holds no key and reads no reference. A blob's key travels only inside
 * the sealed envelope ({@link MUSTS.BLOBS_SEALED}), which this relay cannot
 * open, so what it knows about a job's blobs is exactly what it was asked
 * for: which slots it issued, for which job, in which direction, at what
 * size. Everything below is built from those four facts.
 *
 * ## Three parts, and who supplies each
 *
 * - {@link BlobStore} — where ciphertext lives. **The host's.** A bucket in
 *   a deployment (GCS on byollm.cloud), {@link MemoryBlobStore} here.
 * - {@link BlobLedger} — which slots a job has been issued and when its
 *   blobs go. Short-lived routing state, like a tool call's row:
 *   {@link MemoryBlobLedger} for one replica, a shared one for more.
 * - `RelayBlobs` — the decisions, in this package and nowhere else: no
 *   lease, no URL; no job offered whose stored blobs differ from their
 *   slots; nothing kept past §2's deletion order.
 *
 * ## The job rides in the object name (#7875, choice B)
 *
 * An object is stored at {@link blobObjectName}: site, job, direction, blob.
 * So the bucket alone says which job every object belongs to. Nothing has to
 * be signed into the upload for that — no header the uploader must send, no
 * key on a slot's answer. A ledger that forgets (the hub's routing store
 * keeps nothing across a restart) is rebuilt from the names the next time
 * the job is enqueued, and what no job is enqueued for again is found by
 * the sweep from the names too, once it is too old to belong to anything
 * ({@link ORPHAN_BLOB_AGE_MS}). It is also the address check: a caller
 * names a blob id, and this relay supplies the site and the job from what
 * it has already verified, so no id reaches another job's object.
 *
 * ## The slot's size rides in the blob id
 *
 * {@link mintBlobId} ends each id with its slot's size in padding buckets.
 * The size a stored object is held to is therefore recorded in the one
 * place that cannot be lost separately from the object: its own name.
 */

/** Where one blob lives: whose job, which leg, which blob. */
export interface BlobAddress {
  /** The site, as the control plane names it — from the verified caller. */
  readonly siteId: string;
  /** The job, as its site named it. */
  readonly jobId: string;
  readonly direction: BlobDirection;
  /** The blob id a `BlobRef` names. */
  readonly blob: string;
}

/** One stored object, as a store-wide listing names it. */
export interface StoredBlob {
  readonly address: BlobAddress;
  /** Epoch ms the object was stored, on the store's own clock. */
  readonly storedAt: number;
}

/** A short-lived capability for one object: `PUT` it or `GET` it. */
export interface SignedBlobUrl {
  readonly url: string;
  /** Epoch ms after which the store refuses `url`. */
  readonly expiresAt: number;
}

/**
 * Where blob ciphertext lives — what a relay takes from its host.
 *
 * The mechanism under the endpoints, and it decides nothing: it signs what
 * it is asked to sign. Who may ask is `RelayBlobs`' business, checked before
 * any of these is called.
 *
 * An implementation MUST:
 *
 * 1. **Store an object where its address says.** {@link blobObjectName} is
 *    the name this package's store uses ({@link blobAddressOf} reads one
 *    back); a host may choose another, so long as `list` finds a job's
 *    objects from the site and the job alone and `storedBefore` finds every
 *    object's address from the store alone.
 * 2. **Need nothing from the uploader but the bytes.** `slot` answers a URL
 *    a plain `PUT` of `bytes` octets of `application/octet-stream`
 *    satisfies. No header list is handed back, so there is nowhere to put
 *    one (#7875, choice B).
 * 3. **Report the size actually stored** from `head`, not the size a slot
 *    was signed for. That read is the check (§2: "nothing rests on" the
 *    store enforcing a signed length).
 * 4. **Delete idempotently.** Deleting what is already gone is not an error.
 * 5. **Say when each object was stored**, from the store's own record of
 *    it. The sweep deletes by that time what no ledger record covers, so a
 *    lost ledger does not leave an object waiting for the bucket's rule.
 *
 * It SHOULD make a slot writable once. Where it cannot, an object replaced
 * after its job was offered is caught by the size check a download URL gets
 * before it is issued, and by the device, which stops at the declared size.
 */
export interface BlobStore {
  /** A signed upload of exactly `bytes` octets to `address`. */
  slot(address: BlobAddress, bytes: number): Promise<SignedBlobUrl>;
  /** A signed download of `address`. */
  url(address: BlobAddress): Promise<SignedBlobUrl>;
  /** The stored object's size, or `null` when there is none. */
  head(address: BlobAddress): Promise<number | null>;
  /** Every object stored for one job, from the names alone. */
  list(job: {
    readonly siteId: string;
    readonly jobId: string;
  }): Promise<{ readonly direction: BlobDirection; readonly blob: string }[]>;
  /**
   * Every object stored at or before `time`, across every site and job,
   * from the store alone — no ledger is asked. An object whose name is not
   * one of this store's is left out.
   */
  storedBefore(time: number): Promise<StoredBlob[]>;
  /** Gone. Idempotent. */
  delete(address: BlobAddress): Promise<void>;
  /**
   * Answer one of this store's own URLs, for a store that serves them
   * itself. A bucket's URLs point at the bucket and it has no such method;
   * {@link MemoryBlobStore}'s point back at the relay, which asks here
   * first. `undefined` means the request is not one of this store's.
   */
  serve?(request: Request): Promise<Response | undefined>;
}

/** The fixed prefix every blob object's name starts with. */
export const BLOB_OBJECT_PREFIX = "blobs";

/**
 * One path segment for an id nobody here chose.
 *
 * A site id and a job id are other parties' strings, and a job id is any
 * non-empty string its site liked. As given when it is plainly a segment —
 * which every id this project mints is — so someone reading a bucket during
 * an incident reads the job id itself. Anything else is base64url behind a
 * `~`, which no plain segment contains, so the two forms cannot collide and
 * no id can smuggle a `/` or a `..` into a name.
 */
function segment(id: string): string {
  return /^[A-Za-z0-9_-]{1,200}$/.test(id)
    ? id
    : `~${Buffer.from(id, "utf8").toString("base64url")}`;
}

/** {@link segment}, read back; `null` for what `segment` never wrote. */
function unsegment(part: string): string | null {
  const id = part.startsWith("~")
    ? Buffer.from(part.slice(1), "base64url").toString("utf8")
    : part;
  return id !== "" && segment(id) === part ? id : null;
}

/** The prefix every object of one job is stored under, with its final `/`. */
export function blobJobPrefix(job: {
  readonly siteId: string;
  readonly jobId: string;
}): string {
  return `${BLOB_OBJECT_PREFIX}/${segment(job.siteId)}/${segment(job.jobId)}/`;
}

/**
 * The object name for a blob: `blobs/<site>/<job>/<in|out>/<blob>`.
 *
 * The job is in the name, so the store says which job an object belongs to
 * without asking the relay (#7875, choice B). Refuses a blob id that is not
 * one this relay minted: the id is the last segment, and a name is never
 * built from a string that could be a path.
 */
export function blobObjectName(address: BlobAddress): string {
  if (slotBytesOf(address.blob) === null) {
    throw new Error(
      "a blob object is named only for a blob id this relay minted",
    );
  }
  return `${blobJobPrefix(address)}${address.direction}/${address.blob}`;
}

/**
 * The address {@link blobObjectName} wrote `name` from, or `null` for a
 * name it did not write — what a bucket-backed `storedBefore` reads its
 * listing with.
 */
export function blobAddressOf(name: string): BlobAddress | null {
  const [prefix, site, job, direction, blob, extra] = name.split("/");
  if (
    prefix !== BLOB_OBJECT_PREFIX ||
    site === undefined ||
    job === undefined ||
    (direction !== "in" && direction !== "out") ||
    blob === undefined ||
    extra !== undefined ||
    slotBytesOf(blob) === null
  ) {
    return null;
  }
  const siteId = unsegment(site);
  const jobId = unsegment(job);
  return siteId === null || jobId === null
    ? null
    : { siteId, jobId, direction, blob };
}

/**
 * How old a stored object must be before the sweep deletes it for having no
 * ledger record: the oldest an envelope may be, plus the day blobs are kept
 * past a deadline.
 *
 * The same bound an input slot is given before its job is enqueued, for the
 * same reason. An object with no record is one whose ledger was lost, and
 * nothing in its name says when its job ends — so it is kept for as long as
 * any job it could belong to could still be opened, and a day. 48 hours,
 * where the bucket's own rule would be day 7.
 */
export const ORPHAN_BLOB_AGE_MS =
  ENVELOPE_MAX_AGE_MS + BLOBS_KEPT_AFTER_DEADLINE_MS;

/** 128 random bits as base64url (22 characters), then the bucket count. */
const BLOB_ID = /^[A-Za-z0-9_-]{22}([1-9][0-9]?)$/;
const BLOB_OVERHEAD_BYTES = BLOB_NONCE_BYTES + BLOB_TAG_BYTES;

/**
 * A blob id for a slot of `bytes`: 128 random bits, then the slot's size in
 * padding buckets.
 *
 * `bytes` is an object size (`isBlobObjectSize`), so the bucket count is a
 * whole number from 1 to 80 and says nothing a store does not already see.
 * {@link slotBytesOf} reads it back.
 */
export function mintBlobId(bytes: number): string {
  if (!isBlobObjectSize(bytes)) {
    throw new Error("a slot is whole 256 KiB buckets plus 40 bytes");
  }
  const buckets = (bytes - BLOB_OVERHEAD_BYTES) / BLOB_PADDING_BYTES;
  return `${randomBytes(16).toString("base64url")}${String(buckets)}`;
}

/**
 * The size the slot behind `blob` was issued for, or `null` for an id this
 * relay did not mint.
 */
export function slotBytesOf(blob: string): number | null {
  const buckets = BLOB_ID.exec(blob)?.[1];
  if (buckets === undefined) return null;
  const bytes = Number(buckets) * BLOB_PADDING_BYTES + BLOB_OVERHEAD_BYTES;
  return isBlobObjectSize(bytes) ? bytes : null;
}

/** One slot a job has been issued. Its size is in its id. */
export interface BlobSlot {
  readonly direction: BlobDirection;
  readonly blob: string;
  /**
   * The grant an output slot was issued under. Absent on an input, which a
   * site uploads before any device holds the job.
   */
  readonly leaseId?: string;
}

/** What the ledger keeps for one job: its slots, and when they go. */
export interface BlobJobRecord {
  readonly siteId: string;
  readonly jobId: string;
  /** Issued and not yet deleted. Never empty: an empty record is removed. */
  readonly slots: readonly BlobSlot[];
  /** When everything left is deleted, whatever else happens. */
  readonly deleteAt: number;
  /** When the outputs go without `received`: collection plus an hour. */
  readonly outputDeleteAt?: number;
}

/**
 * Which slots each job has been issued, and when its blobs are deleted.
 *
 * Routing state: short-lived and derived. **Losing it loses the two early
 * clocks, not the deletion**: a ledger that forgets a job is rebuilt from
 * the store's object names when that job is next enqueued, and the objects
 * of a job that never is are deleted by the sweep once they are
 * {@link ORPHAN_BLOB_AGE_MS} old — not at the result, and not an hour after
 * collection, which only a record can say. A ledger that outlives a restart
 * keeps those. {@link MemoryBlobLedger} is correct for one replica; a
 * deployment with more supplies a shared one, for the reason
 * `RoutingStore` is not a `Map`.
 *
 * **Every method is a decision plus its write**, as `RoutingStore`'s are.
 */
export interface BlobLedger {
  /**
   * Record one slot for a job, creating the job's record with `deleteAt` if
   * it has none. One operation, because the count is the decision.
   *
   * MUST first remove every slot of the same direction issued under a
   * *different* lease, and return them as `displaced`: a grant that ended
   * took its outputs with it, and the caller deletes their objects. Inputs
   * carry no lease, so nothing displaces one. MUST then refuse
   * (`issued: false`) when the job already has `max` slots of this
   * direction under this lease.
   */
  issue(input: {
    siteId: string;
    jobId: string;
    slot: BlobSlot;
    max: number;
    deleteAt: number;
  }): Promise<{ issued: boolean; displaced: BlobSlot[] }>;

  /** One job's record, or `undefined`. */
  record(siteId: string, jobId: string): Promise<BlobJobRecord | undefined>;

  /**
   * Move a job's deletion times earlier. **Only ever earlier**: a time later
   * than the one kept is ignored, so collecting a result twice does not
   * extend its outputs. A job with no record is left without one. Called
   * for each finished `llm.image` job on every `results` poll until the
   * job's deadline, so it should cost one conditional write.
   */
  bringForward(input: {
    siteId: string;
    jobId: string;
    deleteAt?: number;
    outputDeleteAt?: number;
  }): Promise<void>;

  /**
   * Forget slots whose objects were deleted: every slot of `direction`, or
   * only the named `blobs` of it; every slot when neither is given. A record
   * left with no slots is removed.
   */
  drop(input: {
    siteId: string;
    jobId: string;
    direction?: BlobDirection;
    blobs?: readonly string[];
  }): Promise<void>;

  /** Every record with a deletion time at or before `now`. */
  due(now: number): Promise<BlobJobRecord[]>;
}

const ledgerKey = (siteId: string, jobId: string): string =>
  `${siteId}\u0000${jobId}`;

/** The in-process {@link BlobLedger}. Not durable, and need not be. */
export class MemoryBlobLedger implements BlobLedger {
  readonly #records = new Map<string, BlobJobRecord>();

  issue(input: {
    siteId: string;
    jobId: string;
    slot: BlobSlot;
    max: number;
    deleteAt: number;
  }): Promise<{ issued: boolean; displaced: BlobSlot[] }> {
    const key = ledgerKey(input.siteId, input.jobId);
    const record = this.#records.get(key);
    const { slot } = input;
    const displaced = (record?.slots ?? []).filter(
      (other) =>
        other.direction === slot.direction && other.leaseId !== slot.leaseId,
    );
    const kept = (record?.slots ?? []).filter(
      (other) => !displaced.includes(other),
    );
    const issued =
      kept.filter((other) => other.direction === slot.direction).length <
      input.max;
    const slots = issued ? [...kept, slot] : kept;
    if (slots.length === 0) {
      this.#records.delete(key);
    } else {
      this.#records.set(key, {
        siteId: input.siteId,
        jobId: input.jobId,
        deleteAt: input.deleteAt,
        ...record,
        slots,
      });
    }
    return Promise.resolve({ issued, displaced });
  }

  record(siteId: string, jobId: string): Promise<BlobJobRecord | undefined> {
    return Promise.resolve(this.#records.get(ledgerKey(siteId, jobId)));
  }

  bringForward(input: {
    siteId: string;
    jobId: string;
    deleteAt?: number;
    outputDeleteAt?: number;
  }): Promise<void> {
    const key = ledgerKey(input.siteId, input.jobId);
    const record = this.#records.get(key);
    if (record === undefined) return Promise.resolve();
    const outputDeleteAt = Math.min(
      record.outputDeleteAt ?? Infinity,
      input.outputDeleteAt ?? Infinity,
    );
    this.#records.set(key, {
      ...record,
      deleteAt: Math.min(record.deleteAt, input.deleteAt ?? Infinity),
      ...(Number.isFinite(outputDeleteAt) ? { outputDeleteAt } : {}),
    });
    return Promise.resolve();
  }

  drop(input: {
    siteId: string;
    jobId: string;
    direction?: BlobDirection;
    blobs?: readonly string[];
  }): Promise<void> {
    const key = ledgerKey(input.siteId, input.jobId);
    const record = this.#records.get(key);
    if (record === undefined) return Promise.resolve();
    const slots = record.slots.filter(
      (slot) =>
        (input.direction !== undefined && slot.direction !== input.direction) ||
        (input.blobs !== undefined && !input.blobs.includes(slot.blob)),
    );
    if (slots.length === 0) this.#records.delete(key);
    else this.#records.set(key, { ...record, slots });
    return Promise.resolve();
  }

  due(now: number): Promise<BlobJobRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter(
        (record) =>
          record.deleteAt <= now || (record.outputDeleteAt ?? Infinity) <= now,
      ),
    );
  }
}

/**
 * How long a memory-store URL works. Short: it is a bearer capability.
 * Fifteen minutes covers a 20 MiB upload on a poor connection.
 */
export const MEMORY_BLOB_URL_TTL_MS = 15 * 60_000;

/** The path {@link MemoryBlobStore}'s URLs are served under. */
export const MEMORY_BLOB_PATH = "/relay/blob-store/";

/**
 * The in-process {@link BlobStore}: objects in a `Map`, URLs back at the
 * relay.
 *
 * For the reference relay, the conformance kit and tests. A deployment
 * supplies a bucket. Like one, it holds ciphertext and nothing that opens
 * it, and its URLs are unguessable, expire, and name one object and one
 * method.
 *
 * **It stores whatever is PUT, at whatever size**, up to one image at the
 * cap. That is on purpose: whether a bucket enforces a signed length is the
 * bucket's behaviour, the relay's own read of the stored size is the check
 * that counts, and a store that enforced it here would hide that check
 * from every test. A slot is written once.
 */
export class MemoryBlobStore implements BlobStore {
  readonly #objects = new Map<string, Uint8Array>();
  readonly #storedAt = new Map<string, number>();
  readonly #urls = new Map<
    string,
    { name: string; method: "PUT" | "GET"; expiresAt: number }
  >();
  readonly #origin: string;
  readonly #now: () => number;

  constructor(options: {
    /** Where the relay is reached, e.g. `http://127.0.0.1:8787`. */
    readonly origin: string;
    readonly now?: () => number;
  }) {
    this.#origin = options.origin.replace(/\/+$/, "");
    this.#now = options.now ?? Date.now;
  }

  #sign(name: string, method: "PUT" | "GET"): SignedBlobUrl {
    const now = this.#now();
    for (const [token, grant] of this.#urls) {
      if (grant.expiresAt <= now) this.#urls.delete(token);
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + MEMORY_BLOB_URL_TTL_MS;
    this.#urls.set(token, { name, method, expiresAt });
    return { url: `${this.#origin}${MEMORY_BLOB_PATH}${token}`, expiresAt };
  }

  slot(address: BlobAddress, _bytes: number): Promise<SignedBlobUrl> {
    return Promise.resolve(this.#sign(blobObjectName(address), "PUT"));
  }

  url(address: BlobAddress): Promise<SignedBlobUrl> {
    return Promise.resolve(this.#sign(blobObjectName(address), "GET"));
  }

  head(address: BlobAddress): Promise<number | null> {
    return Promise.resolve(
      this.#objects.get(blobObjectName(address))?.length ?? null,
    );
  }

  list(job: {
    readonly siteId: string;
    readonly jobId: string;
  }): Promise<{ direction: BlobDirection; blob: string }[]> {
    const prefix = blobJobPrefix(job);
    const found: { direction: BlobDirection; blob: string }[] = [];
    for (const name of this.#objects.keys()) {
      if (!name.startsWith(prefix)) continue;
      const [direction, blob, extra] = name.slice(prefix.length).split("/");
      if (
        (direction === "in" || direction === "out") &&
        blob !== undefined &&
        extra === undefined
      ) {
        found.push({ direction, blob });
      }
    }
    return Promise.resolve(found);
  }

  storedBefore(time: number): Promise<StoredBlob[]> {
    const found: StoredBlob[] = [];
    for (const [name, storedAt] of this.#storedAt) {
      const address = storedAt <= time ? blobAddressOf(name) : null;
      if (address !== null) found.push({ address, storedAt });
    }
    return Promise.resolve(found);
  }

  delete(address: BlobAddress): Promise<void> {
    const name = blobObjectName(address);
    this.#objects.delete(name);
    this.#storedAt.delete(name);
    return Promise.resolve();
  }

  async serve(request: Request): Promise<Response | undefined> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(MEMORY_BLOB_PATH)) return undefined;
    const grant = this.#urls.get(pathname.slice(MEMORY_BLOB_PATH.length));
    // One answer for unknown, expired and wrong-method: a bearer of a bad
    // URL learns nothing about which it was.
    if (
      grant === undefined ||
      grant.expiresAt <= this.#now() ||
      grant.method !== request.method
    ) {
      return new Response(null, { status: 403 });
    }
    if (grant.method === "GET") {
      const object = this.#objects.get(grant.name);
      if (object === undefined) return new Response(null, { status: 404 });
      return new Response(Buffer.from(object), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (this.#objects.has(grant.name)) {
      return new Response(null, { status: 409 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_BLOB_OBJECT_BYTES) {
      return new Response(null, { status: 413 });
    }
    this.#objects.set(grant.name, body);
    this.#storedAt.set(grant.name, this.#now());
    return new Response(null, { status: 200 });
  }

  /**
   * Every stored object, by name — for a test or an audit asserting what
   * this store holds ({@link MUSTS.BLOBS_SEALED}, C048). Not on
   * {@link BlobStore}: a relay never reads an object.
   */
  objects(): ReadonlyMap<string, Uint8Array> {
    return this.#objects;
  }
}

/**
 * The blob store or the ledger could not answer.
 *
 * Its own class so the relay can tell "the bucket is unreachable" from a bug:
 * the first is `server-error`, retryable, and says nothing about why; the
 * second should be loud.
 */
export class BlobStoreFailure extends Error {
  override readonly name = "BlobStoreFailure";
  constructor(cause: unknown) {
    super("the blob store could not answer", { cause });
  }
}

/**
 * `target`, with every method's failure rethrown as a
 * {@link BlobStoreFailure}. Around the two things the host supplies, so the
 * decisions between them fail as themselves.
 */
function guarded<T extends object>(target: T): T {
  return new Proxy(target, {
    get(inner, property) {
      const value: unknown = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return await (value as (...given: unknown[]) => unknown).apply(
            inner,
            args,
          );
        } catch (error) {
          throw new BlobStoreFailure(error);
        }
      };
    },
  });
}

/** A job, as every decision below names it. */
interface JobRef {
  readonly siteId: string;
  readonly jobId: string;
}

/**
 * The relay's blob decisions — the one place they are made.
 *
 * Both planes call this and neither calls the store: a site-plane handler
 * has verified a site, a daemon-plane handler has verified a device and the
 * lease it holds, and each passes the site and the job it established. No
 * method here takes a site or a job from a request body.
 */
export class RelayBlobs {
  readonly #store: BlobStore;
  readonly #ledger: BlobLedger;
  readonly #now: () => Promise<number>;

  constructor(deps: {
    store: BlobStore;
    ledger: BlobLedger;
    now: () => Promise<number>;
  }) {
    this.#store = guarded(deps.store);
    this.#ledger = guarded(deps.ledger);
    this.#now = deps.now;
  }

  /** {@link BlobStore.serve}, when the store serves its own URLs. */
  async serve(request: Request): Promise<Response | undefined> {
    return this.#store.serve?.(request);
  }

  /**
   * An upload slot for one input of a job its site has not enqueued yet.
   *
   * `full` once the job has every input slot an `llm.vision` job may use.
   * Until the enqueue names a deadline the slot is bounded by the oldest an
   * envelope may be: past that nothing could open the job it is for.
   */
  async inputSlot(
    job: JobRef,
    bytes: number,
  ): Promise<({ blob: string } & SignedBlobUrl) | "full"> {
    const now = await this.#now();
    return this.#issue(
      job,
      { direction: "in", blob: mintBlobId(bytes) },
      MAX_IMAGES_IN,
      now + ENVELOPE_MAX_AGE_MS + BLOBS_KEPT_AFTER_DEADLINE_MS,
      bytes,
    );
  }

  /**
   * An upload slot for one output of an `llm.image` job, under the lease
   * its device holds. The caller has checked the lease and the kind.
   *
   * `full` once this lease has every output slot the kind may use. Slots an
   * earlier lease was issued are deleted here: that grant ended, and no
   * result can reference what was uploaded under it.
   */
  async outputSlot(
    job: JobRef & { readonly leaseId: string; readonly deadlineAt: number },
    bytes: number,
  ): Promise<({ blob: string } & SignedBlobUrl) | "full"> {
    return this.#issue(
      job,
      { direction: "out", blob: mintBlobId(bytes), leaseId: job.leaseId },
      MAX_IMAGES_OUT,
      job.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS,
      bytes,
    );
  }

  async #issue(
    job: JobRef,
    slot: BlobSlot,
    max: number,
    deleteAt: number,
    bytes: number,
  ): Promise<({ blob: string } & SignedBlobUrl) | "full"> {
    const { issued, displaced } = await this.#ledger.issue({
      siteId: job.siteId,
      jobId: job.jobId,
      slot,
      max,
      deleteAt,
    });
    await this.#deleteObjects(job, displaced);
    if (!issued) return "full";
    const signed = await this.#store.slot(this.#address(job, slot), bytes);
    return { blob: slot.blob, url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * A download URL for one stored blob, or `null`.
   *
   * `null` for an id this relay did not mint, an object that is not stored,
   * and one that is not the size its slot was issued for — the size is read
   * again here, so an object replaced after its job was offered is not
   * handed on. One answer for all three.
   */
  async downloadUrl(address: BlobAddress): Promise<SignedBlobUrl | null> {
    const expected = slotBytesOf(address.blob);
    if (expected === null) return null;
    if ((await this.#store.head(address)) !== expected) return null;
    const signed = await this.#store.url(address);
    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * Why a job may not be offered, or `null` when it may — the `HEAD` before
   * offer ({@link MUSTS.BLOB_BUDGET_BEFORE_DOWNLOAD}'s last clause, C057).
   *
   * Every input slot this job was issued must hold an object of exactly the
   * size it was issued for: the relay reads the stored size and does not
   * trust the slot. A slot never filled refuses the job too, and so does an
   * `llm.vision` job with no input at all — the relay cannot read which
   * blobs the sealed payload names, so the slots are what "its blobs" means
   * here.
   *
   * A refused job's inputs are deleted with the refusal: it is not offered,
   * so nothing will read them, and a site that enqueues the same id again
   * starts from no slots.
   *
   * A job with no record is looked for in the store by name first, so a
   * ledger that forgot it (a restart) still checks what was stored and
   * still deletes it on time.
   */
  async inputFault(
    job: JobRef & { readonly kind: string; readonly deadlineAt: number },
  ): Promise<string | null> {
    const deleteAt = job.deadlineAt + BLOBS_KEPT_AFTER_DEADLINE_MS;
    let record = await this.#ledger.record(job.siteId, job.jobId);
    if (record === undefined) {
      for (const slot of await this.#store.list(job)) {
        if (slotBytesOf(slot.blob) === null) continue;
        await this.#ledger.issue({
          siteId: job.siteId,
          jobId: job.jobId,
          slot,
          max: Number.MAX_SAFE_INTEGER,
          deleteAt,
        });
      }
      record = await this.#ledger.record(job.siteId, job.jobId);
    }
    const inputs = (record?.slots ?? []).filter(
      (slot) => slot.direction === "in",
    );
    let fault: string | null = null;
    if (job.kind === "llm.vision" && inputs.length === 0) {
      fault = "this llm.vision job has no stored input blob";
    }
    for (const slot of inputs) {
      if (fault !== null) break;
      fault = await this.#slotFault(job, slot);
    }
    if (fault !== null) {
      await this.#deleteObjects(job, inputs);
      await this.#ledger.drop({ ...job, direction: "in" });
      return fault;
    }
    await this.#ledger.bringForward({
      siteId: job.siteId,
      jobId: job.jobId,
      deleteAt,
    });
    return null;
  }

  /**
   * Why an `ok` result may not be accepted, or `null` when it may — the
   * same check an input gets, on the outputs issued under this lease.
   */
  async outputFault(
    job: JobRef & { readonly leaseId: string },
  ): Promise<string | null> {
    const record = await this.#ledger.record(job.siteId, job.jobId);
    for (const slot of record?.slots ?? []) {
      if (slot.direction !== "out" || slot.leaseId !== job.leaseId) continue;
      const fault = await this.#slotFault(job, slot);
      if (fault !== null) return fault;
    }
    return null;
  }

  async #slotFault(job: JobRef, slot: BlobSlot): Promise<string | null> {
    const stored = await this.#store.head(this.#address(job, slot));
    if (stored === null) return `blob ${slot.blob} was never uploaded`;
    return stored === slotBytesOf(slot.blob)
      ? null
      : `blob ${slot.blob} is not the size its slot was issued for`;
  }

  /**
   * A result was accepted: the inputs go now, since nothing reads them
   * again. So do the outputs of a result that is not `ok`, which no
   * reference will ever name.
   */
  async resultAccepted(
    job: JobRef,
    disposition: "ok" | "error" | "canceled",
  ): Promise<void> {
    const record = await this.#ledger.record(job.siteId, job.jobId);
    if (record === undefined) return;
    const going = record.slots.filter(
      (slot) => slot.direction === "in" || disposition !== "ok",
    );
    await this.#deleteObjects(job, going);
    await this.#ledger.drop({
      ...job,
      ...(disposition === "ok" ? { direction: "in" as const } : {}),
    });
  }

  /**
   * Results were handed to their site: each one's outputs now go within the
   * hour unless the site says sooner that it holds them. **Not now** — the
   * site downloads after it collects (C059).
   */
  async collected(siteId: string, jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return;
    const outputDeleteAt =
      (await this.#now()) + OUTPUT_KEPT_AFTER_COLLECTION_MS;
    for (const jobId of jobIds) {
      await this.#ledger.bringForward({ siteId, jobId, outputDeleteAt });
    }
  }

  /** The site holds these outputs: they are deleted now. */
  async received(job: JobRef, blobs: readonly string[]): Promise<void> {
    await this.#deleteObjects(
      job,
      blobs.map((blob) => ({ direction: "out" as const, blob })),
    );
    await this.#ledger.drop({ ...job, direction: "out", blobs });
  }

  /**
   * Delete whatever the clock says is due, and count it.
   *
   * Outputs an hour after collection without `received`; everything a job
   * has left a day after its deadline. Then the objects no record covers —
   * a ledger that was lost, with nothing enqueued again to rebuild it —
   * once they are {@link ORPHAN_BLOB_AGE_MS} old, found from the store's
   * names and its stored times alone. The store's own lifecycle rule is the
   * floor under this, for the case where it does not run.
   */
  async sweep(): Promise<number> {
    const now = await this.#now();
    let deleted = 0;
    for (const record of await this.#ledger.due(now)) {
      const all = record.deleteAt <= now;
      const going = record.slots.filter(
        (slot) => all || slot.direction === "out",
      );
      await this.#deleteObjects(record, going);
      await this.#ledger.drop({
        siteId: record.siteId,
        jobId: record.jobId,
        ...(all ? {} : { direction: "out" as const }),
      });
      deleted += going.length;
    }
    for (const { address } of await this.#store.storedBefore(
      now - ORPHAN_BLOB_AGE_MS,
    )) {
      // An object its job's record still names is that record's to delete,
      // on the clock it carries.
      const record = await this.#ledger.record(address.siteId, address.jobId);
      const covered = record?.slots.some(
        (slot) =>
          slot.direction === address.direction && slot.blob === address.blob,
      );
      if (covered === true) continue;
      await this.#store.delete(address);
      deleted += 1;
    }
    return deleted;
  }

  #address(
    job: JobRef,
    slot: Pick<BlobSlot, "direction" | "blob">,
  ): BlobAddress {
    return {
      siteId: job.siteId,
      jobId: job.jobId,
      direction: slot.direction,
      blob: slot.blob,
    };
  }

  async #deleteObjects(
    job: JobRef,
    slots: readonly Pick<BlobSlot, "direction" | "blob">[],
  ): Promise<void> {
    for (const slot of slots) {
      // An id this relay did not mint names no object of its own.
      if (slotBytesOf(slot.blob) === null) continue;
      await this.#store.delete(this.#address(job, slot));
    }
  }
}
