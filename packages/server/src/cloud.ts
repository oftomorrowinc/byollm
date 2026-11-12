import { openSealedOutcome } from "./sealed-outcome.js";
import { keptOutcome, readAtMost } from "./blobs.js";
import {
  PROTOCOL_VERSION,
  type ImageSealedOutcome,
  type JobKind,
  type SealedOutcome,
  type ResultDisposition,
  type SealedEnvelope,
  keyId,
  open,
  publicIdentityOf,
  provenanceFor,
  signSiteRequest,
  SiteToolCalls,
  toolsRefusalText,
  type JobStub,
  type SiteEnqueueTools,
  type PublicIdentity,
  type StoredKeys,
} from "@byollm/protocol";
import { deadlineFor } from "./records.js";
import type { JobRecord } from "./records.js";
import { resealForDevice } from "./reseal.js";
import type { ByollmStore } from "./store.js";
import type { ListedCall, SiteTools, ToolsReport } from "./site-tools.js";

/**
 * The cloud lane — cloud_004 §9.4.
 *
 * `app.enqueue(...)` is identical in every lane; the lane picks the connection
 * plane. In `direct` mode a daemon reaches the site's own handlers. In `cloud`
 * mode it reaches a relay instead, and the site's side of that is this file.
 *
 * ## What actually changes, and what deliberately does not
 *
 * Enqueue does not change at all. The job is validated, sealed at rest to the
 * site's own key and stored, exactly as before — jobs-at-rest encryption is a
 * direct-mode property that the cloud lane inherits rather than replaces.
 *
 * What changes is *who asks for the payload and when*. On the direct plane the
 * daemon asks, and the site answers synchronously because it is the upstream.
 * Through a relay the site is not the upstream, so nobody asks: the site has to
 * find out that a device claimed its job, and seal to that device. Hence a
 * pump rather than a handler.
 *
 * ```
 *  enqueue ──stub──▶ relay        (payload stays here, sealed at rest)
 *                      │
 *   pump ◀──who claimed it, and what key?
 *        ──payload sealed to that device──▶
 *   pump ◀──sealed result──  ──▶ store.complete → the app's delivery channel
 * ```
 *
 * ## Why the site polls
 *
 * Everything in this product is outbound. A relay that called site webhooks
 * would need every site publicly reachable, which is the connectivity problem
 * the hub exists to remove — and a serverless site has nowhere to receive a
 * webhook anyway. So the site polls, exactly as a daemon does.
 */

export interface CloudLaneOptions {
  /**
   * Where the relay lives, e.g. `https://hub.byollm.cloud`.
   *
   * This said `relay.byollm.cloud`, and that name **has no DNS record**.
   * The comment ships in the published `.d.ts`, so it is among the first
   * examples a site author reads: Kevin's team copied the dead host into
   * every app's `.env.example` and then worked out why nothing connected.
   *
   * The old name is written here without a scheme on purpose, so that
   * `the-links-we-ship-resolve.mjs` does not report this explanation as one
   * more dead host.
   */
  readonly relayOrigin: string;
  /** This site's id at the relay. */
  readonly siteId: string;
  /** Injectable fetch, for tests and for proxies. */
  readonly fetch?: typeof fetch;
}

/** What one pump cycle did, for logging and for tests. */
/**
 * A relay that could not answer this request — alpha.31.
 *
 * `retryable` is the whole point: a draining pod and a bad signature are both
 * failures, and treating them alike is how a site either falls over on every
 * deploy or stays silently disconnected for a week.
 */
export class RelayUnavailable extends Error {
  readonly retryable: boolean;
  /** The protocol's own code, when the relay sent one. */
  readonly code: string;

  constructor(message: string, retryable: boolean, code: string) {
    super(message);
    this.name = "RelayUnavailable";
    this.retryable = retryable;
    this.code = code;
  }
}

/**
 * The job was not queued, and waiting will not change that.
 *
 * Distinct from {@link RelayUnavailable} because it is the opposite situation:
 * the relay answered, promptly and correctly, and the answer is that this job
 * has nowhere to go. Catching "the relay is down" to handle "nobody has chosen
 * a model" would retry forever against a fact.
 *
 * Three codes, and they belong to different people.
 *
 * `purpose-not-declared` is the site's own manifest. It names the purpose and
 * the remedy, because a developer reading their own logs is entitled to both
 * and neither says anything about a person.
 *
 * `slot-unsatisfiable` is the person's own dashboard, and says only that.
 * Which service, whose device, whether one exists at all — none of it travels,
 * and the sentence is the same for everybody. A site learns *that* a slot
 * cannot be satisfied, which is exactly what the README has always promised
 * and what this class finally delivers.
 *
 * `slot-waiting` is the one bit beyond that a site may learn, and it answers a
 * different question: **does this need the person, or only time.**
 * `slot-unsatisfiable` means somebody has to go and choose a model, and no
 * amount of waiting helps. `slot-waiting` means the slot may recover with
 * nobody acting — device asleep, service withdrawn, account blocked all
 * arrive as one sentence, which is what makes the bit safe to give. It is
 * about the slot's future, not the person's day.
 *
 * **This said "two codes" for the release that shipped the third.** The relay
 * has answered `slot-waiting` since 019 §6.3 and nothing on this side named
 * it, so a site reading the SDK's own contract would have branched on two of
 * three — see `the-refusals-we-name.test.ts`, which compares this list against
 * what the relay can actually send.
 */
export class EnqueueRefused extends Error {
  /**
   * `purpose-not-declared`, `slot-unsatisfiable` or `slot-waiting` — or, for
   * an `llm.tools` job, `tools-manifest-mismatch`: the tools this site
   * declares in code for the purpose differ from its registered manifest
   * (byollm_012 §4, C047). Register the manifest, or fix the declaration;
   * retrying changes nothing.
   */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "EnqueueRefused";
    this.code = code;
  }
}

/**
 * The one code that means "ask me later" on the enqueue endpoint.
 *
 * Inverted on 2026-09-02, and the inversion is the point. This was an
 * allowlist of *refusals* — `purpose-not-declared` and `slot-unsatisfiable` —
 * which made every refusal code the relay might add next a breaking change
 * for every client already deployed: an unknown code fell through to
 * `RelayUnavailable`, so a site's `catch (error instanceof EnqueueRefused)`
 * silently stopped matching and a permanent refusal was retried forever.
 *
 * The status class is the key; a list of codes is a description of it. A 409
 * on enqueue means the relay declined to queue the job, so there is nothing to
 * await — whatever the code turns out to be.
 *
 * **Nothing to await is not nothing to retry, and this said both — B261.**
 * `slot-waiting` means the slot may recover with nobody acting, so retrying it
 * later is the right answer; the class it arrives as says the job was not
 * queued, which is also true. Both stand, and the schedule is the site's:
 *
 *   - `purpose-not-declared` — your manifest. Fix it; retrying changes nothing.
 *   - `slot-unsatisfiable` — nobody has chosen what answers this. It needs the
 *     person, and no amount of waiting helps.
 *   - `slot-waiting` — **worth trying again later.** Mapped, and nothing can
 *     answer right now: a device asleep, a service withdrawn, an account over
 *     its cap. It clears on its own.
 *
 * Ruled rather than assumed, 09-18: `slot-waiting` stays an `EnqueueRefused`
 * because nothing was queued, and because `RelayUnavailable` would be a false
 * sentence — the relay is fine — carrying it into a defer path built for
 * `not-ready`, which clears in seconds. A slot can wait hours, and routing
 * hours through a seconds-scale retry hammers somebody's closed laptop.
 *
 * `409` alone is not the key, which is why this is not simply deleted: the
 * protocol overloads it. `not-ready` is a draining pod saying come back, and
 * `too-late` is about a job that already exists. Neither can reach the
 * enqueue endpoint as a refusal, so the discriminator is the class *on this
 * endpoint*, with the retryable code named because it is the exception.
 *
 * The direction of the default is deliberate. An unknown code treated as a
 * refusal surfaces as an error somebody can see; treated as unavailable it
 * becomes a silent retry against a condition that will never change — which
 * is the shape of the afternoon Kevin lost.
 */
const RETRYABLE_AT_ENQUEUE = new Set(["not-ready"]);

/** An endpoint this relay does not have — see `#getUnlessAbsent`. */
const ABSENT = Symbol("absent");

/**
 * What a relay with no blob endpoints is told about, in one sentence.
 *
 * A relay before 0.1.5-beta.2 answers `/relay/blobs` 404, and so does a
 * newer one whose host gave it no blob store. Either way the fix is the
 * relay's, and no retry changes it.
 */
const NO_IMAGES =
  "this relay carries no images (404 on blobs) — it predates byollm 0.1.5 " +
  "or has no blob store";

/** The one content type a blob is: ciphertext, never what it decrypts to. */
const BLOB_CONTENT_TYPE = "application/octet-stream";

/** The endpoint where a decline means the job was never queued. */
const ENQUEUE_ENDPOINT = "enqueue";

/**
 * How the hub's `tools-manifest-mismatch` sentence ends — byollm_012 §4.
 *
 * The hub refuses a mismatch as `bad-request` with `toolsRefusalText`'s
 * sentence, not with a new code, because a new value in the closed
 * `WireErrorCode` is breaking on the side nobody upgraded (`ToolsRefusal`'s
 * docstring). So the sentence is the signal, and this is its fixed tail,
 * taken from the same function the relay writes it with — the two cannot
 * drift without this file's test going red.
 */
const TOOLS_MISMATCH_TAIL = ((): string => {
  const marker = "\u0000";
  const parts = toolsRefusalText("tools-manifest-mismatch", {
    site: marker,
    purpose: marker,
  }).split(marker);
  return parts[parts.length - 1] ?? "";
})();

export interface PumpReport {
  /** Jobs sealed to a claiming device this cycle. */
  readonly sealed: string[];
  /** Results opened, verified and written to the store. */
  readonly completed: string[];
  /**
   * Jobs the relay offered that this site refused to seal for.
   *
   * Never silent: a site that cannot open its own at-rest envelope has a key
   * problem, and a device waiting on a payload that will never come is
   * exactly the case `awaiting-payload` exists to bound.
   */
  readonly refused: string[];
  /**
   * Why this cycle stopped early, when it did — alpha.31.
   *
   * A relay can legitimately say "ask me later": a pod draining through its
   * `preStop` window answers `503 not-ready` to every routed call, and that
   * happens on **every deploy**. Before this existed the lane read the body
   * of that answer, found no `jobs` in it, and threw `TypeError: finished.jobs
   * is not iterable` — a site falling over because its relay was polite.
   *
   * Absent on an ordinary cycle. Present, with the reason, when the lane
   * deferred: a site that quietly did nothing and a site that was told to wait
   * must not look the same in a log.
   */
  readonly deferred?: string;
  /**
   * The tool calls this cycle answered — byollm_012 §5.2 (#6933, card 4).
   *
   * Absent when the relay carries no tools (see {@link toolsUnavailable}) or
   * the cycle deferred before it got there.
   */
  readonly tools?: ToolsReport;
  /**
   * Why the `calls` step was skipped, when it was: a relay older than 0.1.5
   * answers `calls` 404, and that is read as "this relay carries no tools",
   * not as a failure (byollm_021 R2). The rest of the cycle still ran, so a
   * site that upgrades before its relay keeps working.
   */
  readonly toolsUnavailable?: string;
}

export class CloudLane {
  readonly #options: CloudLaneOptions;
  readonly #store: ByollmStore;
  readonly #siteKeys: StoredKeys;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #tools: SiteTools | undefined;
  /**
   * Upload slots this process was issued and has not used, by blob id.
   *
   * In memory, and that is enough: a slot is asked for and filled within one
   * `enqueue`, and one that outlives its process has expired at the store
   * before anything could look for it.
   */
  readonly #slots = new Map<string, { url: string; expiresAt: number }>();

  constructor(deps: {
    options: CloudLaneOptions;
    store: ByollmStore;
    siteKeys: StoredKeys;
    now: () => number;
    /** The site's tool handlers, for the pump's `calls` step. */
    tools?: SiteTools;
  }) {
    this.#options = deps.options;
    this.#tools = deps.tools;
    this.#store = deps.store;
    this.#siteKeys = deps.siteKeys;
    this.#now = deps.now;
    this.#fetch = deps.options.fetch ?? globalThis.fetch;
  }

  /**
   * Publish a job's stub for routing.
   *
   * The stub and nothing else — byollm_009 §6 makes that exhaustive by
   * construction, so this cannot leak a payload even by mistake: there is no
   * field on `JobStub` to put one in.
   */
  async publish(record: JobRecord, tools?: SiteEnqueueTools): Promise<void> {
    const stub: JobStub = {
      id: record.id,
      kind: record.kind,
      owner: record.owner,
      // This site, by its identity key id — Amendment A §A.3. The relay
      // already knows which site it is routing for, so this discloses nothing
      // new to it; what it adds is that the *daemon* can check the stub
      // against the envelope's `senderKeyId` without asking the relay.
      site: keyId(publicIdentityOf(this.#siteKeys).identity),
      audience: record.audience,
      // `audienceAllow` is deliberately **not** published — cloud_008 §0.2.
      //
      // It is a list of the people who may run this job, and on the direct
      // plane that is unremarkable: the site authored the list and the site is
      // the upstream, so the party receiving it already has it. Through a
      // relay it is a third party, and byollm_009 §6's enumerated metadata —
      // "exhaustive and normative… what an upstream can see, stated as a
      // commitment" — does not include it. It was reaching the relay on every
      // named-audience job.
      //
      // Nothing is lost by withholding it, which is why this is a Tier 0 fix
      // rather than a trade. `matchAudience` treats it as a *narrowing*:
      // `job.audienceAllow !== undefined && !includes(daemon.owner)` refuses,
      // and its absence simply falls through to the checks that actually
      // enforce — the daemon's own allowlist (`NAMED_LOCAL_ALLOWLIST`) and the
      // backend's offer scope. On this lane the relay narrows too, from the
      // control plane's rosters. The enforcement was never here.
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      sizeClass: record.sizeClass,
      streaming: false,
      // The relay needs *a* deadline to bound routing. A job without one gets
      // the envelope's, which is the outer bound on how long the ciphertext
      // is worth carrying — never longer than the work could possibly matter.
      // The same fallback the direct plane uses — cloud_008 Tier 4, finding
      // 31. This said `createdAt + ENVELOPE_TTL_FALLBACK`, a local constant
      // whose value happened to equal `ENVELOPE_MAX_AGE_MS`; the direct plane
      // said `(claimableAt ?? now) + ttlMs`. One field, two meanings, and a
      // job that was blocked on a dependency got a deadline measured from
      // when it was *created* on one lane and from when it became *claimable*
      // on the other.
      deadlineAt: deadlineFor(record, this.#now()),
    };
    await this.#post("enqueue", {
      siteId: this.#options.siteId,
      stub,
      // Beside the stub, never in it — byollm_012 §4, §8. `stub` is
      // exhaustive by construction (`STUB_METADATA_EXHAUSTIVE`) and reaches
      // devices; this reaches the relay and the hub only. Sent exactly for
      // `llm.tools`, which a 0.1.4 relay refuses anyway, so no other
      // enqueue's bytes change.
      ...(tools === undefined ? {} : { tools }),
    });
  }

  /**
   * Withdraw a job at the relay — cloud_008 §2.2.
   *
   * `app.cancel()` marks the site's own row terminal, which stops the *next*
   * seal. It cannot stop a device that is already running the work, because
   * on this lane the site is not the upstream: only the relay talks to the
   * daemon, and it answered `cancel: []` unconditionally.
   *
   * So the cancellation has to travel. The relay marks the job, stops
   * offering it, and names it to the holding device at its next heartbeat —
   * the same path the direct plane has always had, arriving one hop later.
   */
  async cancel(jobId: string): Promise<void> {
    await this.#post("cancel", { siteId: this.#options.siteId, jobId });
  }

  // -- blobs — byollm_021 §2, "The cloud lane" (#7875) ----------------------
  //
  // The site's half of images by reference through a relay: ask for a slot,
  // `PUT` the ciphertext straight to the store, and on the way back ask for
  // a download, `GET` it, and say when every output is held. The relay never
  // sees a byte or a key; `ByollmApp` encrypts before calling these and
  // decrypts after, so nothing here handles plaintext either.

  /**
   * `POST /relay/blobs` — an upload slot for one input image of a job not
   * yet enqueued. `bytes` is the object's size (`blobObjectBytes`), and the
   * relay holds the stored object to it before the job is offered.
   */
  async blobSlot(jobId: string, bytes: number): Promise<{ blob: string }> {
    const answer = (await this.#blobPost("blobs", {
      siteId: this.#options.siteId,
      jobId,
      direction: "in",
      bytes,
    })) as { blob?: unknown; url?: unknown; expiresAt?: unknown } | null;
    // Read by the three keys this needs and no stricter: a slot already
    // issued is not un-issued by a key this SDK does not know.
    if (
      typeof answer?.blob !== "string" ||
      typeof answer.url !== "string" ||
      typeof answer.expiresAt !== "number"
    ) {
      throw new RelayUnavailable(
        "blobs: the relay's answer is not an upload slot",
        false,
        "bad-response",
      );
    }
    this.#slots.set(answer.blob, {
      url: answer.url,
      expiresAt: answer.expiresAt,
    });
    return { blob: answer.blob };
  }

  /**
   * `PUT` one blob's ciphertext to the slot {@link CloudLane.blobSlot}
   * issued for it. Once per slot.
   *
   * Ciphertext, its length, and one content type — the same `PUT` a daemon
   * makes for an output. The job a blob belongs to is in the object name the
   * relay chose, so there is nothing else to send (#7875, choice B).
   */
  async uploadBlob(blob: string, object: Uint8Array): Promise<void> {
    const slot = this.#slots.get(blob);
    this.#slots.delete(blob);
    if (slot === undefined || slot.expiresAt <= this.#now()) {
      throw new RelayUnavailable(
        `blobs: no open upload slot ${blob} — ask for one with blobSlot`,
        false,
        "no-slot",
      );
    }
    const response = await this.#fetch(slot.url, {
      method: "PUT",
      headers: { "content-type": BLOB_CONTENT_TYPE },
      body: object,
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw new RelayUnavailable(
        `blobs: the blob store refused an upload with HTTP ${String(response.status)}`,
        response.status >= 500 || response.status === 429,
        "blob-upload",
      );
    }
  }

  /**
   * One output blob's ciphertext: `POST /relay/blobs/download` for a URL,
   * then a `GET` that **stops at `size` bytes** — the object size the
   * reference declares. A store that sends more is not believed for the
   * rest, and `decryptBlob` opens nothing but the exact size.
   */
  async downloadBlob(
    jobId: string,
    blob: string,
    size: number,
  ): Promise<Uint8Array> {
    const answer = (await this.#blobPost("blobs/download", {
      siteId: this.#options.siteId,
      jobId,
      blob,
    })) as { url?: unknown } | null;
    if (typeof answer?.url !== "string") {
      throw new RelayUnavailable(
        "blobs/download: the relay's answer is not a download URL",
        false,
        "bad-response",
      );
    }
    const response = await this.#fetch(answer.url, { redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RelayUnavailable(
        `blobs/download: the blob store returned HTTP ${String(response.status)}`,
        response.status >= 500 || response.status === 429,
        "blob-download",
      );
    }
    const object = await readAtMost(response.body, size);
    if (object === null) {
      throw new RelayUnavailable(
        "blobs/download: a blob was larger than its reference declares, so " +
          "its download was stopped at the declared size",
        false,
        "blob-download",
      );
    }
    return object;
  }

  /**
   * `POST /relay/blobs/received` — this site holds these output blobs, so
   * the relay deletes them now rather than an hour after collection.
   */
  async received(jobId: string, blobs: readonly string[]): Promise<void> {
    await this.#blobPost("blobs/received", {
      siteId: this.#options.siteId,
      jobId,
      blobs,
    });
  }

  /**
   * A blob call: `/relay/<endpoint>`, signed under that endpoint's name.
   *
   * A bare 404 — no message — is a relay with no such endpoint, and is
   * said as that ({@link NO_IMAGES}). A 404 that names what was not found
   * is this relay answering about one blob, and goes through as it is.
   */
  async #blobPost(endpoint: string, body: unknown): Promise<unknown> {
    const response = await this.#send(endpoint, body, `/relay/${endpoint}`);
    if (response.status === 404) {
      const said = (await response
        .clone()
        .json()
        .catch(() => null)) as { message?: unknown } | null;
      if (typeof said?.message !== "string") {
        throw new RelayUnavailable(NO_IMAGES, false, "no-images");
      }
    }
    return this.#answer(response, endpoint);
  }

  /**
   * One cycle: seal for anything claimed, collect anything finished.
   *
   * Idempotent and safe to call as often as you like. Exposed as a single
   * cycle rather than hidden behind a timer so a caller decides its own
   * cadence — a serverless site runs it on a cron, a long-lived one on an
   * interval, and a test runs it exactly when it means to.
   */
  async pump(): Promise<PumpReport> {
    const sealed: string[] = [];
    const refused: string[] = [];
    const completed: string[] = [];

    try {
      return await this.#cycle(sealed, refused, completed);
    } catch (error) {
      // Retryable: end the cycle, keep what was done, say why. Anything else
      // is a fact about this site's configuration and belongs to the caller —
      // a swallowed 401 is a site disconnected from its users with nothing in
      // any log to say so.
      if (error instanceof RelayUnavailable && error.retryable) {
        return { sealed, completed, refused, deferred: error.message };
      }
      throw error;
    }
  }

  async #cycle(
    sealed: string[],
    refused: string[],
    completed: string[],
  ): Promise<PumpReport> {
    const pending = (await this.#get("pending")) as {
      jobs: {
        jobId: string;
        device: PublicIdentity;
        runnerId: string;
        leaseId: string;
        awaitingUntil: number;
        leaseExpiresAt: number;
      }[];
    };
    for (const claim of pending.jobs) {
      const record = await this.#store.get(claim.jobId);
      if (!record) continue;
      const resealed = await resealForDevice({
        siteKeys: this.#siteKeys,
        job: {
          id: record.id,
          envelope: record.envelope,
          createdAt: record.createdAt,
        },
        device: claim.device,
      });
      if (!resealed.ok) {
        refused.push(claim.jobId);
        continue;
      }
      // Record the lease the relay granted, before handing over the work.
      //
      // The site is not the upstream here and does not decide who holds what
      // — but its own row has to know, or two things break that are not
      // cosmetic: `complete` refuses the result for want of a matching lease,
      // and the expiry sweep expires a job a device is in the middle of.
      // Adopting first means the worst case is a lease recorded for work that
      // never gets sealed, which the relay's own timeout already resolves.
      //
      // **The lease's clock, not the payload's** — cloud_008 §0.6. This
      // adopted `awaitingUntil`, which is how long the relay waits for *this
      // site to seal* (byollm_009 §7.1's third clock, ten seconds), and used
      // it as the expiry of a grant the device holds for a minute and renews
      // for as long as it works. Both of the breakages listed above then
      // happened to every job slower than the shorter clock — the site expired
      // the lease, the device finished anyway, and `complete` refused the
      // result the device had correctly produced.
      const adopted = await this.#store.adopt({
        jobId: claim.jobId,
        leaseId: claim.leaseId,
        expiresAt: claim.leaseExpiresAt,
        now: this.#now(),
      });
      // `null` means this store will not lend the job out — cloud_008 §2.2.
      //
      // Its own comment says why it refuses: a terminal or already-leased job
      // means the relay and this store disagree about reality. **And the
      // return value was being discarded**, so the site went on to seal the
      // payload to the claiming device anyway — for a job the app had already
      // cancelled, or whose deadline had passed, or that another lease
      // already owned.
      //
      // Sealing is the irreversible half: once the ciphertext is with the
      // relay, a device can fetch and run it. Refusing here is what makes
      // `adopt` a decision rather than a formality, and the job is reported
      // as refused so a site operator sees it rather than a device waiting
      // for work that will never be sealed.
      if (!adopted) {
        refused.push(claim.jobId);
        continue;
      }
      await this.#post("payload", {
        siteId: this.#options.siteId,
        jobId: claim.jobId,
        envelope: resealed.envelope,
      });
      sealed.push(claim.jobId);
    }

    // The tool calls waiting on this site — byollm_012 §5.2. Between the
    // payloads and the results: a payload sealed above may be answered with
    // a call within the same cycle on a fast device, and a call answered
    // here may let a result be collected below.
    const calls = await this.#calls();

    /* `ResultDisposition`, not `string` — B064 step 4's extraction surfaced
       this. A hand-written cast of a wire response retypes the shape at the
       consumer, and this field lost its union on the way: the relay declares
       `"ok" | "error" | "canceled"` and this said `string`, so nothing here
       could tell a disposition from any other text. Instruction 9, in the
       small. */
    const finished = (await this.#get("results")) as {
      jobs: {
        jobId: string;
        envelope: SealedEnvelope;
        disposition: ResultDisposition;
        runnerId: string;
        leaseId: string;
        device: PublicIdentity;
        runnerOwner: string;
      }[];
    };
    for (const done of finished.jobs) {
      const record = await this.#store.get(done.jobId);
      if (!record || record.state === "ok" || record.state === "error") {
        continue;
      }
      const outcome = await this.#openResult({ ...done, kind: record.kind });
      if (!outcome) {
        refused.push(done.jobId);
        continue;
      }
      // Provenance is built here, from the job's audience and the device the
      // relay named — never from anything the daemon asserted. Identical to
      // the direct plane's rule, and it has to be: a result arriving via a
      // relay is not more trustworthy for having travelled further.
      await this.#store.complete({
        jobId: done.jobId,
        // The relay named the device; the signature above proved it — §3.6.
        runnerId: done.runnerId,
        // The grant, not the machine: this site never paired with the device
        // that ran it, and the signature it verified above is the stronger
        // claim about who did.
        holder: { by: "lease", leaseId: done.leaseId },
        // An `llm.image` answer's references are kept with their keys
        // wrapped, as on the direct lane. The relay held each output to its
        // slot's size before it took the result; what each one decrypts to
        // is checked when `images()` downloads it.
        outcome: keptOutcome(this.#siteKeys, done.jobId, outcome.outcome),
        provenance: provenanceFor({
          audience: record.audience,
          runnerId: done.runnerId,
          // The owner, from the relay's own record of who claimed it — not a
          // key id. cloud_008 §2.5: this said `keyId(device.identity)`, which
          // put a key id where the direct plane puts a user id, so an app
          // comparing provenance across lanes compared two namespaces and got
          // `false` for the same person. The device's key is still what the
          // signature was verified against, above; that is a different
          // question from whose machine it is.
          runnerOwner: done.runnerOwner,
          // From the envelope, not invented — cloud_008 §2.5. These were
          // hardcoded `"http"` and `"unknown"` because the daemon's declared
          // values stopped at the relay, which is right: a blind relay acts
          // on neither. Sealing them carries them past it untouched.
          backendClass: outcome.ran.backendClass,
          model: outcome.ran.model,
          /* B260. `ran` arrives sealed through the relay untouched, and this
             rebuild took two of its fields and left the rest — so a
             cloud-lane site could not tell a truncated answer from a whole
             one. The relay reads none of this; it travels inside the
             envelope. */
          ...(outcome.ran.stop === undefined ? {} : { stop: outcome.ran.stop }),
          ...(outcome.ran.stopReported === undefined
            ? {}
            : { stopReported: outcome.ran.stopReported }),
        }),
        now: this.#now(),
      });
      completed.push(done.jobId);
    }

    return { sealed, completed, refused, ...calls };
  }

  /**
   * The pump's `calls` step: collect, run handlers, seal and post.
   *
   * **A 404 on `calls` is a relay that carries no tools** — byollm_021 R2,
   * "0.1.5 site, 0.1.4 hub". It is not a failure: the cycle goes on to
   * collect results, so a site that upgrades before its relay keeps working.
   * Asked again every cycle, never remembered, so the cycle after the relay
   * upgrades answers its calls.
   *
   * Only `calls` is read this way. A 404 on `tool-result` is a 0.1.5 relay
   * saying that one call is not waiting any more, and is reported as late.
   */
  async #calls(): Promise<
    { tools: ToolsReport } | { toolsUnavailable: string }
  > {
    const listed = await this.#getUnlessAbsent("calls");
    if (listed === ABSENT) {
      return {
        toolsUnavailable:
          "the relay carries no tools (404 on calls) — it predates byollm 0.1.5",
      };
    }
    const { calls, unreadable } = readCalls(listed);
    if (this.#tools === undefined) {
      // A lane built without the app's handlers has nothing to run them
      // with; the calls time out at the device, and the report says so.
      return {
        tools: {
          answered: [],
          errored: [],
          refused: [],
          dropped: [...unreadable, ...calls.map((call) => call.callId)],
          late: [],
        },
      };
    }
    const tools = await this.#tools.answer(calls, async (answer) => {
      try {
        // A 2xx is the relay keeping the answer. Its body is not read: an
        // answer already sealed and kept is not un-kept by a field this SDK
        // does not know.
        await this.#post("tool-result", {
          siteId: this.#options.siteId,
          ...answer,
        });
        return "accepted";
      } catch (error) {
        // `not-found` and `too-late` are about this call alone: it timed out
        // or its grant ended while the handler ran. Anything else is the
        // relay's, and the cycle's retry rules apply to it.
        if (
          error instanceof RelayUnavailable &&
          (error.code === "not-found" || error.code === "too-late")
        ) {
          return error.code;
        }
        throw error;
      }
    });
    return { tools: { ...tools, dropped: [...unreadable, ...tools.dropped] } };
  }

  /**
   * Open a sealed result and verify it came from the device that claimed it.
   *
   * The relay says which device ran the job; this checks that claim against a
   * signature the relay cannot produce. A relay that named the wrong device
   * gets a refusal, not a stored result — which is what keeps `RELAY_BLIND`
   * from quietly becoming `RELAY_TRUSTED`.
   */
  async #openResult(done: {
    jobId: string;
    envelope: SealedEnvelope;
    disposition: ResultDisposition;
    device: PublicIdentity;
    kind: JobKind;
  }): Promise<SealedOutcome | ImageSealedOutcome | null> {
    const opened = await open({
      envelope: done.envelope,
      recipientKeys: this.#siteKeys,
      senderIdentityPublic: done.device.identity,
      expected: {
        jobId: done.jobId,
        senderKeyId: keyId(done.device.identity),
        recipientKeyId: keyId(publicIdentityOf(this.#siteKeys).identity),
        direction: "result",
      },
    });
    if (!opened.ok) return null;

    // One function, both lanes — see `sealed-outcome.ts`. The disposition
    // check lives inside it, because this is the only party that can open the
    // envelope (byollm_009 §6.1) and therefore the only place the relay's
    // clear-text routing hint can be checked against the truth.
    const outcome = openSealedOutcome({
      plaintext: opened.plaintext,
      disposition: done.disposition,
      kind: done.kind,
    });
    return outcome.ok ? outcome.value : null;
  }

  /**
   * Sign a site-plane call with this site's identity key.
   *
   * The same scheme the daemon uses against an upstream, because the site is
   * in the same position: an outbound caller whose key the relay already holds
   * for other reasons. Nothing else authenticates this plane — a relay that
   * took the `siteId` in a body at face value would let anyone enqueue work in
   * a site's name and read who claimed it.
   */
  #headers(endpoint: string, rawBody: string): Record<string, string> {
    const signature = signSiteRequest(this.#siteKeys, {
      endpoint,
      siteId: this.#options.siteId,
      issuedAt: this.#now(),
      body: rawBody,
    });
    return {
      "x-byollm-site": this.#options.siteId,
      "x-byollm-issued-at": String(signature.issuedAt),
      "x-byollm-signature": signature.signature,
    };
  }

  /**
   * A relay answer, checked before it is believed — alpha.31.
   *
   * The bug this closes is one line long and its shape is general: a response
   * body used without looking at the status. The daemon's client has always
   * done this properly (`client.ts` maps every status to a typed refusal); the
   * site's lane parsed JSON and hoped.
   *
   * Two classes, because they need opposite handling. **Retryable** — 503 from
   * a draining pod, 429, 5xx, and the protocol's own `not-ready` — means the
   * work is still there and this cycle should end quietly. **Refused** — a bad
   * signature, an unknown site, a version this relay does not speak — will
   * still be true in five seconds, and swallowing it would leave a site
   * silently disconnected from its own users.
   */
  async #answer(response: Response, endpoint: string): Promise<unknown> {
    if (response.ok) return response.json();

    let code = "";
    let message: string;
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      code = body.error ?? "";
      message = body.message ?? "";
    } catch {
      // A body that is not JSON is an intermediary answering, not the relay.
      message = `HTTP ${String(response.status)}`;
    }

    const retryable =
      response.status >= 500 ||
      response.status === 429 ||
      code === "not-ready" ||
      code === "server-error";

    if (
      endpoint === ENQUEUE_ENDPOINT &&
      response.status === 400 &&
      code === "bad-request" &&
      TOOLS_MISMATCH_TAIL !== "" &&
      message.endsWith(TOOLS_MISMATCH_TAIL)
    ) {
      // The hub compared the `toolsDigest` beside the stub with its manifest
      // of record and nothing was queued — byollm_012 §4, C047. A refusal,
      // not an outage: retrying sends the same digest.
      throw new EnqueueRefused(message, "tools-manifest-mismatch");
    }

    if (
      endpoint === ENQUEUE_ENDPOINT &&
      response.status === 409 &&
      !RETRYABLE_AT_ENQUEUE.has(code)
    ) {
      // No job exists, so there is nothing to await. Whether it is worth
      // trying again later depends on the code, and the class's docstring
      // says which one is — `slot-waiting` clears on its own.
      // The code travels unread: a site branching on one it does not know
      // still learns that its job was refused, which is the fact it needs.
      throw new EnqueueRefused(message, code);
    }

    throw new RelayUnavailable(
      `${endpoint}: ${code || "refused"} — ${message}`,
      retryable,
      code,
    );
  }

  async #post(endpoint: string, body: unknown): Promise<unknown> {
    return this.#answer(await this.#send(endpoint, body), endpoint);
  }

  /** One signed site-plane `POST`, answered or not. */
  async #send(
    endpoint: string,
    body: unknown,
    path = `/relay/site/${endpoint}`,
  ): Promise<Response> {
    // The version travels in the body, as it does on the daemon plane — §B.4.
    // Added here rather than at each call site so a new site-plane call cannot
    // be written without it, which is how the site plane came to be outside
    // the handshake in the first place.
    const rawBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...(body as Record<string, unknown>),
    });
    return this.#fetch(`${this.#options.relayOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.#headers(endpoint, rawBody),
      },
      body: rawBody,
    });
  }

  /**
   * A read whose 404 means the relay has no such endpoint — {@link ABSENT}.
   *
   * Only for an endpoint added after the site plane first shipped, where a
   * 404 from an older relay is the expected answer rather than a refusal.
   */
  async #getUnlessAbsent(endpoint: string): Promise<unknown> {
    const response = await this.#fetch(this.#url(endpoint), {
      headers: this.#headers(endpoint, ""),
    });
    if (response.status === 404) return ABSENT;
    return this.#answer(response, endpoint);
  }

  /** A GET has no body, so the version rides in the query — `declaredVersion`. */
  #url(endpoint: string): string {
    return (
      `${this.#options.relayOrigin}/relay/site/${endpoint}` +
      `?siteId=${encodeURIComponent(this.#options.siteId)}` +
      `&protocolVersion=${encodeURIComponent(PROTOCOL_VERSION)}`
    );
  }

  async #get(endpoint: string): Promise<unknown> {
    // A GET has no body, so the version rides in the query — the other half
    // of `declaredVersion`, and the reason that helper takes both.
    // A read signs an empty body: the site id is in the query and in the
    // signed caller slot, and the relay refuses the request unless they agree.
    const response = await this.#fetch(this.#url(endpoint), {
      headers: this.#headers(endpoint, ""),
    });
    return this.#answer(response, endpoint);
  }
}

/** One entry of the relay's `calls`, as this SDK reads it. */
const ListedCallSchema = SiteToolCalls.shape.calls.element;

/**
 * The relay's `calls` answer, read entry by entry.
 *
 * Not one strict parse of the whole answer, because that would make one
 * unreadable entry — or a field a newer relay added — fail the whole pump
 * cycle, results and all. Each entry is read on its own; one this SDK cannot
 * read is a call it cannot answer, reported as dropped by its id where it
 * has one, and the rest are answered. An answer with no `calls` list at all
 * is not a relay speaking this protocol, and is thrown.
 */
function readCalls(listed: unknown): {
  calls: ListedCall[];
  unreadable: string[];
} {
  const entries = (listed as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(entries)) {
    throw new RelayUnavailable(
      "calls: the relay's answer has no list of calls",
      false,
      "bad-response",
    );
  }
  const calls: ListedCall[] = [];
  const unreadable: string[] = [];
  for (const entry of entries as unknown[]) {
    const parsed = ListedCallSchema.safeParse(entry);
    if (parsed.success) {
      calls.push(parsed.data);
      continue;
    }
    const callId = (entry as { callId?: unknown } | null)?.callId;
    if (typeof callId === "string") unreadable.push(callId);
  }
  return { calls, unreadable };
}
