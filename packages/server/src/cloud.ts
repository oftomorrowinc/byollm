import {
  JobOutcome,
  type SealedEnvelope,
  keyId,
  open,
  publicIdentityOf,
  provenanceFor,
  type JobStub,
  type PublicIdentity,
  type StoredKeys,
} from "@byollm/protocol";
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
      audience: record.audience,
      ...(record.audienceAllow === undefined
        ? {}
        : { audienceAllow: [...record.audienceAllow] }),
      sizeClass: record.sizeClass,
      streaming: false,
      // The relay needs *a* deadline to bound routing. A job without one gets
      // the envelope's, which is the outer bound on how long the ciphertext
      // is worth carrying — never longer than the work could possibly matter.
      deadlineAt: record.deadlineAt ?? record.createdAt + ENVELOPE_TTL_FALLBACK,
    };
    await this.#post("/relay/site/enqueue", {
      siteId: this.#options.siteId,
      stub,
    });
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

    const pending = (await this.#get("/relay/site/pending")) as {
      jobs: {
        jobId: string;
        device: PublicIdentity;
        runnerId: string;
        leaseId: string;
        awaitingUntil: number;
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
      await this.#store.adopt({
        jobId: claim.jobId,
        leaseId: claim.leaseId,
        expiresAt: claim.awaitingUntil,
        now: this.#now(),
      });
      await this.#post("/relay/site/payload", {
        siteId: this.#options.siteId,
        jobId: claim.jobId,
        envelope: resealed.envelope,
      });
      sealed.push(claim.jobId);
    }

    const finished = (await this.#get("/relay/site/results")) as {
      jobs: {
        jobId: string;
        envelope: SealedEnvelope;
        disposition: string;
        runnerId: string;
        leaseId: string;
        device: PublicIdentity;
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
        // The grant, not the machine: this site never paired with the device
        // that ran it, and the signature it verified above is the stronger
        // claim about who did.
        holder: { by: "lease", leaseId: done.leaseId },
        outcome,
        provenance: provenanceFor({
          audience: record.audience,
          runnerId: done.runnerId,
          runnerOwner: keyId(done.device.identity),
          backendClass: "http",
          model: "unknown",
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
  }): Promise<JobOutcome | null> {
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
    const outcome = JobOutcome.safeParse(parsed);
    if (!outcome.success) return null;
    // The clear-text disposition is a routing hint the relay acted on. This
    // is the only place it can be checked, because this is the only party
    // that can open the envelope (byollm_009 §6.1).
    if (outcome.data.outcome !== done.disposition) return null;
    return outcome.data;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.relayOrigin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async #get(path: string): Promise<unknown> {
    const url = `${this.#options.relayOrigin}${path}?siteId=${encodeURIComponent(this.#options.siteId)}`;
    const response = await this.#fetch(url);
    return response.json();
  }
}

/** Only used when a job carries no deadline of its own. */
const ENVELOPE_TTL_FALLBACK = 24 * 60 * 60_000;
