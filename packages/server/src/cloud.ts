import {
  PROTOCOL_VERSION,
  SealedOutcome,
  type SealedEnvelope,
  keyId,
  open,
  publicIdentityOf,
  provenanceFor,
  signSiteRequest,
  type JobStub,
  type PublicIdentity,
  type StoredKeys,
} from "@byollm/protocol";
import { deadlineFor } from "./records.js";
import type { JobRecord } from "./records.js";
import { resealForDevice } from "./reseal.js";
import type { ByollmStore } from "./store.js";

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
  /** Where the relay lives, e.g. `https://relay.byollm.cloud`. */
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
 * Two codes, and they belong to two different people.
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
 */
export class EnqueueRefused extends Error {
  /** `purpose-not-declared` or `slot-unsatisfiable`. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "EnqueueRefused";
    this.code = code;
  }
}

/** The refusals that mean "not queued", rather than "try again later". */
const REFUSED_AT_ENQUEUE = new Set([
  "purpose-not-declared",
  "slot-unsatisfiable",
]);

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
}

export class CloudLane {
  readonly #options: CloudLaneOptions;
  readonly #store: ByollmStore;
  readonly #siteKeys: StoredKeys;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;

  constructor(deps: {
    options: CloudLaneOptions;
    store: ByollmStore;
    siteKeys: StoredKeys;
    now: () => number;
  }) {
    this.#options = deps.options;
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
  async publish(record: JobRecord): Promise<void> {
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

    const finished = (await this.#get("results")) as {
      jobs: {
        jobId: string;
        envelope: SealedEnvelope;
        disposition: string;
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
      const outcome = await this.#openResult(done);
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
        outcome: outcome.outcome,
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
        }),
        now: this.#now(),
      });
      completed.push(done.jobId);
    }

    return { sealed, completed, refused };
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
    disposition: string;
    device: PublicIdentity;
  }): Promise<SealedOutcome | null> {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(opened.plaintext);
    } catch {
      return null;
    }
    const sealed = SealedOutcome.safeParse(parsed);
    if (!sealed.success) return null;
    // The clear-text disposition is a routing hint the relay acted on. This
    // is the only place it can be checked, because this is the only party
    // that can open the envelope (byollm_009 §6.1).
    if (sealed.data.outcome.outcome !== done.disposition) return null;
    return sealed.data;
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

    if (REFUSED_AT_ENQUEUE.has(code)) {
      // No job exists, so there is nothing to await and nothing to retry.
      throw new EnqueueRefused(message, code);
    }

    throw new RelayUnavailable(
      `${endpoint}: ${code || "refused"} — ${message}`,
      retryable,
      code,
    );
  }

  async #post(endpoint: string, body: unknown): Promise<unknown> {
    // The version travels in the body, as it does on the daemon plane — §B.4.
    // Added here rather than at each call site so a new site-plane call cannot
    // be written without it, which is how the site plane came to be outside
    // the handshake in the first place.
    const rawBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...(body as Record<string, unknown>),
    });
    const response = await this.#fetch(
      `${this.#options.relayOrigin}/relay/site/${endpoint}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.#headers(endpoint, rawBody),
        },
        body: rawBody,
      },
    );
    return this.#answer(response, endpoint);
  }

  async #get(endpoint: string): Promise<unknown> {
    // A GET has no body, so the version rides in the query — the other half
    // of `declaredVersion`, and the reason that helper takes both.
    const url =
      `${this.#options.relayOrigin}/relay/site/${endpoint}` +
      `?siteId=${encodeURIComponent(this.#options.siteId)}` +
      `&protocolVersion=${encodeURIComponent(PROTOCOL_VERSION)}`;
    // A read signs an empty body: the site id is in the query and in the
    // signed caller slot, and the relay refuses the request unless they agree.
    const response = await this.#fetch(url, {
      headers: this.#headers(endpoint, ""),
    });
    return this.#answer(response, endpoint);
  }
}
