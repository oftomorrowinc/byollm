import {
  ENVELOPE_MAX_AGE_MS,
  KindedPayload,
  keyId,
  payloadTextLength,
  publicIdentityOf,
  seal,
  sizeClassOf,
  type StoredKeys,
  backendDescriptor,
  matchAudience,
  type DeliveredResult,
  type JobKind,
  type MatchRefusal,
} from "@byollm/protocol";
import {
  PollingDelivery,
  type PollingDeliveryDeps,
  type ResultDelivery,
  type WaitOptions,
} from "./delivery.js";
import { generateJobId, generateRunnerId } from "./ids.js";
import { CloudLane, type CloudLaneOptions } from "./cloud.js";
import type { EnqueueInput, JobRecord, RunnerRecord } from "./records.js";
import type { ByollmStore } from "./store.js";

/**
 * How long since a runner's last heartbeat before it stops counting as live.
 * Three heartbeats of slack at the daemon's ~10s cadence.
 */
const DEFAULT_LIVENESS_MS = 35_000;

/** Why a job cannot presently run. */
export type NoRunnerReason =
  | "no-runner-paired"
  | "no-runner-online"
  | "no-matching-capability"
  | "audience-admits-nobody"
  /**
   * A service was named and nothing advertises it — byollm_016 Phase B.
   *
   * Distinct from `no-matching-capability`, which means nothing serves the
   * *kind* at all. Here the kind is served and the name is not one of them, so
   * the fix is different: a typo, or a service the person has not enabled.
   *
   * Safe to distinguish **here** and nowhere else. This answers the site about
   * its own users' devices, whose capabilities it already stores; the same
   * split on the wire would let a stranger probe names to enumerate somebody
   * else's machine, which is why `RefusalReason` collapses it to one value.
   */
  | "no-such-service"
  /**
   * A kind two services answer with no default chosen, so the daemon
   * withholds it — byollm_016. Nothing is wrong with the device; its owner has
   * a decision to make, and saying "no matching capability" would send them
   * looking for a missing install instead.
   */
  | "awaiting-default"
  /**
   * The owner's default for this kind can never serve *this* requester —
   * byollm_016's defaults-meet-audiences corner.
   *
   * The specimen: a default of `claude-cli`, self-locked by
   * `SUBSCRIPTION_SELF_LOCK`, and a team member's unselected job. It resolves
   * to something that will never run it. Reported rather than left to time
   * out, because a wait that can never end is indistinguishable from one that
   * has not ended yet, and only one of them is worth waiting through.
   */
  | "default-unusable";

/**
 * The no-runner signal (byollm_001 Rev 1 §D).
 *
 * `available: false` means an app should fall back — hosted model, "start
 * your runner" prompt — rather than awaiting something that will never
 * resolve. A job still blocked on dependencies is **not** unavailable; it is
 * waiting, and saying otherwise would make every multi-job flow look broken
 * ({@link MUSTS.NO_RUNNER_SIGNAL}).
 */
export interface RunnerAvailability {
  readonly available: boolean;
  readonly reason?: NoRunnerReason;
  /** Live runners that could take work of this shape. */
  readonly candidates: number;
}

export interface AvailabilityQuery {
  readonly kind: JobKind;
  readonly owner: string;
  /** The service the job named, if it named one — byollm_016 Phase B. */
  readonly service?: string;
  readonly audience?: "private" | "team" | "public";
  readonly audienceAllow?: readonly string[];
}

export interface ByollmAppOptions {
  readonly store: ByollmStore;
  /** Injectable clock. */
  readonly now?: () => number;
  /** Liveness window for the no-runner signal. */
  readonly livenessMs?: number;
  /**
   * How the app learns a job finished. Defaults to polling the store, which
   * is correct everywhere; the Supabase adapter substitutes Realtime.
   */
  readonly delivery?: (deps: PollingDeliveryDeps) => ResultDelivery;
  /**
   * How long a sustained no-runner signal must persist before `result()`
   * gives up. Longer tolerates a daemon restarting; shorter fails faster.
   */
  readonly noRunnerGraceMs?: number;
  /**
   * This site's keypairs — the same ones the handlers use.
   *
   * The app needs them because it is the *endpoint*: it seals work on the way
   * in and opens results on the way out. Nothing between those two points
   * holds plaintext (byollm_009 §10).
   */
  readonly siteKeys: StoredKeys;
  /**
   * Which connection plane this site uses — cloud_004 §9.4.
   *
   * Omitted means `direct`: a daemon reaches this site's own handlers, and
   * everything works as it always has. Supplying a relay switches the plane
   * and nothing else — `enqueue` is identical in every lane, which is the
   * property that lets the same app move between them by config.
   */
  readonly lane?: CloudLaneOptions;
}

/**
 * An enqueued job, with the delivery channel attached.
 *
 * `result()` is sugar over the channel — with a timeout and a
 * `noRunnerAvailable` path — never a bare promise that can hang forever
 * (byollm_003 Rev 1).
 */
export interface JobHandle {
  readonly id: string;
  /** The job as stored at enqueue time. */
  readonly record: JobRecord;
  /** Wait for a terminal outcome. */
  result(options?: WaitOptions): Promise<DeliveredResult>;
  /** Ask the runner to stop. */
  cancel(): Promise<void>;
}

/**
 * The app-facing half of `@byollm/server`.
 *
 * The daemon talks to {@link ByollmHandlers}; the app talks to this. Keeping
 * them separate is what makes "one door per state write" hold — an app
 * enqueues and cancels through these methods and never writes job rows by
 * hand.
 */
/**
 * Every option `enqueue` accepts, as data.
 *
 * `Record<keyof EnqueueInput, true>` rather than a hand-kept array, so the
 * compiler refuses this file when a field is added to `EnqueueInput` and not
 * to this list. An allowlist that silently falls behind the type it guards is
 * worse than none: it would start rejecting the very field somebody just
 * added, in the name of catching typos.
 */
const ENQUEUE_OPTIONS: Readonly<Record<keyof EnqueueInput, true>> =
  Object.freeze({
    kind: true,
    payload: true,
    owner: true,
    audience: true,
    service: true,
    audienceAllow: true,
    dependsOn: true,
    ttlMs: true,
    deadlineAt: true,
    id: true,
  });

export class ByollmApp {
  readonly #store: ByollmStore;
  readonly #siteKeys: StoredKeys;
  readonly #now: () => number;
  readonly #livenessMs: number;
  readonly #delivery: ResultDelivery;
  /** Present only in the cloud lane; the site's side of the relay. */
  readonly cloud: CloudLane | undefined;

  constructor(options: ByollmAppOptions) {
    this.#store = options.store;
    this.#siteKeys = options.siteKeys;
    this.#now = options.now ?? Date.now;
    this.#livenessMs = options.livenessMs ?? DEFAULT_LIVENESS_MS;
    this.cloud =
      options.lane === undefined
        ? undefined
        : new CloudLane({
            options: options.lane,
            store: options.store,
            siteKeys: options.siteKeys,
            now: this.#now,
          });

    const deps: PollingDeliveryDeps = {
      ...(options.noRunnerGraceMs === undefined
        ? {}
        : { graceMs: options.noRunnerGraceMs }),
      read: (jobId) => this.result(jobId),
      availability: async (jobId) => {
        const job = await this.#store.get(jobId);
        if (!job)
          return { available: false, reason: "unknown-job", blocked: false };
        // A job waiting on a dependency is waiting, not unavailable.
        if (job.claimableAt === null) {
          return { available: true, blocked: true };
        }
        const availability = await this.runnerAvailability({
          kind: job.kind,
          owner: job.owner,
          audience: job.audience,
          ...(job.audienceAllow === undefined
            ? {}
            : { audienceAllow: job.audienceAllow }),
        });
        return {
          available: availability.available,
          ...(availability.reason === undefined
            ? {}
            : { reason: availability.reason }),
          blocked: false,
        };
      },
    };
    this.#delivery = options.delivery?.(deps) ?? new PollingDelivery(deps);
  }

  /**
   * Enqueue a job.
   *
   * `audience` defaults to `self` — the safe direction. Widening it means the
   * result comes back marked untrusted (see {@link ByollmApp.result}), and
   * the app is obliged to disclose that to whoever reads it.
   */
  async enqueue(input: EnqueueInput): Promise<JobHandle> {
    // An option this SDK does not know is refused, never ignored.
    //
    // A caller newer than its SDK is the ordinary way this happens, and the
    // case that produced the rule: a site called `enqueue({ service })`
    // against a version that predated the field, the key went nowhere, and
    // nothing said so. The app believed it was selecting a service, was not,
    // and the only symptom was work running on one nobody chose. Silence is
    // the hazard rather than the missing feature.
    const unknown = Object.keys(input).filter(
      (key) => !(key in ENQUEUE_OPTIONS),
    );
    if (unknown.length > 0) {
      throw new Error(
        `enqueue does not understand ${unknown.map((k) => `\`${k}\``).join(", ")}. ` +
          `An option this @byollm/server does not know is refused rather than ` +
          `ignored, because an ignored option is a job that runs differently ` +
          `than you asked with nothing to see — most often an SDK older than ` +
          `the code calling it. Upgrade @byollm/server, or remove the option.`,
      );
    }

    // Validate the payload against its kind before anything stores it.
    //
    // The schemas are `.strict()`, so this drops a payload carrying fields
    // the kind does not define — `command`, `argv`, `model`, `baseUrl`. Types
    // do not survive a JSON boundary, and an app assembling a payload from
    // user input is the ordinary case, so "the caller is typed" is not a
    // check ({@link MUSTS.KIND_NO_CODE}, {@link MUSTS.NO_PAYLOAD_ROUTING}).
    //
    // Refusing here rather than relying on the daemon is deliberate. The
    // daemon does re-validate and would reject this — but it parses a whole
    // claim response at once, so one malformed job would fail the batch it
    // arrived in and stall unrelated work. Rejecting at enqueue puts the
    // error where the app can act on it.
    const parsed = KindedPayload.safeParse({
      kind: input.kind,
      payload: input.payload,
    });
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`invalid ${input.kind} payload — ${detail}`);
    }

    // Sealed before it is stored, to this site's own key. The app is the
    // endpoint, so it can open its own work later; the store, its backups and
    // anything reading them cannot.
    // Two different deadlines, deliberately not conflated:
    //
    // - the *job's* deadline is the app's business, may be absent, and for a
    //   dependent job its TTL clock does not even start until the job becomes
    //   claimable (`TTL_EXPIRY`). Setting one here broke exactly that.
    // - the *envelope's* deadline bounds how long a captured ciphertext is
    //   worth keeping. It is bound into the signature, so it has to be
    //   recomputable at open time from what the record stores — hence
    //   creation plus TTL, which never moves.
    // Resolved *here*, once, and passed to the store — because the envelope
    // binds it. Letting the app default one value and the store default
    // another produced a job whose seal and record disagreed, and therefore
    // work nobody could open.
    // One reading of the clock, used for both the seal and the record.
    //
    // Two readings passed every fake-clock test and failed against a real
    // one: the envelope bound `createdAt + ttlMs` from the first call and the
    // record stored `createdAt` from the second, a millisecond later, so
    // nothing could be opened. A fixed clock returns the same number twice
    // and hides it completely.
    const createdAt = this.#now();
    // Independent of the job's TTL, deliberately. Binding the envelope to
    // `createdAt + ttl` meant the app had to decide a TTL in order to seal —
    // which overrode the store's own default and broke every expiry test.
    // The two answer different questions: how long the work is worth doing,
    // and how long the ciphertext is worth keeping.
    const envelopeDeadlineAt = createdAt + ENVELOPE_MAX_AGE_MS;
    const jobId = input.id ?? generateJobId();
    const senderKeyId = keyId(publicIdentityOf(this.#siteKeys).identity);
    const envelope = await seal({
      plaintext: JSON.stringify(parsed.data.payload),
      senderKeys: this.#siteKeys,
      recipientEncryptionPublic: this.#siteKeys.encryptionPublic,
      context: {
        jobId,
        senderKeyId,
        recipientKeyId: senderKeyId,
        deadlineAt: envelopeDeadlineAt,
        direction: "payload",
      },
    });

    const record = await this.#store.create(
      {
        ...input,
        id: jobId,
        envelope,
        sizeClass: sizeClassOf(
          payloadTextLength({
            kind: input.kind,
            payload: parsed.data.payload,
          } as Parameters<typeof payloadTextLength>[0]),
        ),
      },
      createdAt,
    );
    // The lane's only intrusion into enqueue, and it is additive: the record
    // is already stored and sealed at rest before anything is published, so a
    // relay that is down costs a routing delay rather than a lost job.
    await this.cloud?.publish(record);

    return {
      id: record.id,
      record,
      result: (options?: WaitOptions) =>
        this.#delivery.waitFor(record.id, options),
      cancel: async () => {
        await this.cancel(record.id);
      },
    };
  }

  /** Read a job's current state. */
  async job(jobId: string): Promise<JobRecord | null> {
    await this.#store.expireDue(this.#now());
    return this.#store.get(jobId);
  }

  /**
   * A job's result with its provenance attached.
   *
   * Check `provenance.untrusted` before rendering. It is true for every
   * `named`/`public` job, because that text came from someone else's machine
   * and the app must not present it as its own AI's answer
   * ({@link MUSTS.PROVENANCE_NAMES_DEVICE}).
   */
  async result(jobId: string): Promise<DeliveredResult | null> {
    const job = await this.job(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      state: job.state,
      ...(job.outcome === null ? {} : { outcome: job.outcome }),
      ...(job.provenance === null ? {} : { provenance: job.provenance }),
    };
  }

  /** Ask a runner to stop. Queued jobs cancel at once; held jobs at the next heartbeat. */
  async cancel(jobId: string): Promise<JobRecord | null> {
    const cancelled = await this.#store.cancel(jobId, this.#now());
    // On the cloud lane the relay is the only party talking to the daemon, so
    // a cancellation that stops at this store stops a *future* seal and
    // nothing else — cloud_008 §2.2. Told after the row is terminal, so the
    // two can only disagree in the safe direction: the relay may briefly
    // still offer a job this site will now refuse to seal for.
    //
    // Not awaited into the caller's error path: an app cancelling a job has
    // cancelled it, and a relay that is unreachable must not turn that into a
    // thrown error. The relay's own deadline sweep is the backstop.
    if (cancelled && this.cloud) {
      await this.cloud.cancel(jobId).catch(() => undefined);
    }
    return cancelled;
  }

  /**
   * Is there a live runner that could take a job of this shape?
   *
   * Runs the identical {@link matchAudience} rule the claim path uses, so the
   * signal cannot promise a runner the claim would then refuse.
   */
  async runnerAvailability(
    query: AvailabilityQuery,
  ): Promise<RunnerAvailability> {
    const now = this.#now();
    const all = await this.#store.listRunners();
    const live = all.filter(
      (runner) =>
        runner.revokedAt === null &&
        !runner.paused &&
        now - runner.lastHeartbeatAt <= this.#livenessMs,
    );

    if (all.length === 0) {
      return { available: false, reason: "no-runner-paired", candidates: 0 };
    }
    if (live.length === 0) {
      return { available: false, reason: "no-runner-online", candidates: 0 };
    }

    let capable = 0;
    let admitted = 0;
    // byollm_016 Phase B. A named service must be matched by name; an
    // unnamed one goes to whichever service the owner made the default, and
    // *not* to whatever else answers that kind — matching the menu here would
    // report a job as runnable that the router will not route.
    let servesKind = 0;
    let withheldSomewhere = 0;
    let lastRefusal: MatchRefusal | undefined;
    for (const runner of live) {
      const forKind = runner.capabilities.filter((c) => c.kind === query.kind);
      if (forKind.length > 0) servesKind += 1;

      const capability =
        query.service === undefined
          ? forKind.find((c) => c.isDefault)
          : forKind.find((c) => c.service === query.service);

      // A device that answers this kind, advertises no default for it, and
      // was not asked for a name: the withheld state, which is a decision
      // waiting rather than a thing missing.
      if (
        capability === undefined &&
        query.service === undefined &&
        forKind.length > 0
      ) {
        withheldSomewhere += 1;
      }
      if (!capability) continue;
      capable += 1;

      const match = matchAudience(
        {
          owner: query.owner,
          audience: query.audience ?? "private",
          audienceAllow: query.audienceAllow,
        },
        {
          owner: runner.owner,
          offerScope: capability.offerScope,
          // A generic backend's cost depends on its base URL, which the
          // server never sees; assume the expensive reading (byollm_007 §4).
          cost: backendDescriptor(capability.backendId).cost ?? "metered",
          // Consent is the daemon's to hold, and it has already applied it:
          // the offer scope arriving here is the *effective* one, so a
          // metered backend nobody agreed to share advertises `self` and is
          // refused by the scope rule above. Re-deriving consent from
          // `false` here would instead refuse every backend an owner
          // deliberately shared, because the server has no way to learn they
          // did — the signal would be wrong in the direction that breaks
          // working setups.
          spend: { acknowledged: true },
          // Same conservative assumption the claim path makes: the server
          // cannot see a remote daemon's local allowlist (protocol §4.2).
          locallyAllows: () => true,
        },
      );
      if (match.ok) admitted += 1;
      else lastRefusal = match.refusal;
    }

    if (capable === 0) {
      // Ordered most specific first, because each one sends the reader
      // somewhere different: fix a typo, choose a default, or install
      // something. Collapsing them would send everybody to the last.
      const reason: NoRunnerReason =
        query.service !== undefined && servesKind > 0
          ? "no-such-service"
          : withheldSomewhere > 0
            ? "awaiting-default"
            : "no-matching-capability";
      return { available: false, reason, candidates: 0 };
    }
    if (admitted === 0) {
      // Something serves it and nothing may serve *this requester*. When the
      // job named nothing, that is the defaults-meet-audiences corner — the
      // owner's default resolved to a service this person can never use — and
      // it is worth its own word, because "nobody is admitted" reads as a
      // permissions problem the requester could ask to have fixed, while this
      // one is fixed by the device's owner choosing differently.
      // Whose decision blocked it, not merely that something did. The first
      // draft asked "did the job name a service", which reclassified a job
      // whose *own* audience was `private` and whose only device belonged to
      // somebody else — telling that caller "the owner's default cannot serve
      // you" when the exclusion was their own choice. An existing test caught
      // it, which is the argument for keeping the older reason rather than
      // widening the new one.
      //
      // So it splits on the refusal `matchAudience` already produced: a scope
      // or billing refusal is the *device owner's* setting, which only they
      // can change; an audience refusal is the *caller's*, which they can.
      const ownersDoing =
        lastRefusal === "offer-scope-too-narrow" ||
        lastRefusal === "subscription-self-lock" ||
        lastRefusal === "metered-no-spend-consent" ||
        lastRefusal === "metered-ceiling-reached";
      return {
        available: false,
        reason:
          query.service === undefined && ownersDoing
            ? "default-unusable"
            : "audience-admits-nobody",
        candidates: 0,
      };
    }
    return { available: true, candidates: admitted };
  }

  /**
   * Approve a pairing on behalf of an authenticated user.
   *
   * `owner` MUST come from the approving user's own session. A daemon can
   * never assert who it is — that is the whole reason pairing is interactive
   * ({@link MUSTS.PAIR_ONE_USER}, {@link MUSTS.PAIR_INTERACTIVE}).
   */
  async approvePairing(args: {
    userCode: string;
    owner: string;
  }): Promise<RunnerRecord> {
    return this.#store.approvePairing({
      userCode: normalizeUserCode(args.userCode),
      owner: args.owner,
      runnerId: generateRunnerId(),
      now: this.#now(),
    });
  }

  /** Deny a pairing the user did not initiate. */
  async denyPairing(userCode: string): Promise<void> {
    return this.#store.denyPairing(normalizeUserCode(userCode), this.#now());
  }

  /** What a pairing code refers to, for the approval page to show. */
  async pendingPairing(userCode: string): Promise<{
    label: string;
    platform: string;
    daemonVersion: string;
    capabilities: readonly { kind: string; model: string }[];
    expiresAt: number;
  } | null> {
    const pairing = await this.#store.getPairingByUserCode(
      normalizeUserCode(userCode),
    );
    if (pairing?.state !== "pending") return null;
    if (pairing.expiresAt <= this.#now()) return null;
    return {
      label: pairing.label,
      platform: pairing.platform,
      daemonVersion: pairing.daemonVersion,
      capabilities: pairing.capabilities.map((c) => ({
        kind: c.kind,
        model: c.model,
      })),
      expiresAt: pairing.expiresAt,
    };
  }

  /** The user's paired runners, for a settings page. */
  async runners(owner: string): Promise<RunnerRecord[]> {
    return this.#store.listRunners(owner);
  }

  /** Revoke a runner. It stops at its next heartbeat, mid-queue. */
  async revokeRunner(runnerId: string): Promise<void> {
    return this.#store.revokeRunner(runnerId, this.#now());
  }

  /** Run the expiry sweep. Idempotent; safe to call on a timer or a request. */
  async sweep(): Promise<JobRecord[]> {
    return this.#store.expireDue(this.#now());
  }
}

/**
 * Accept a pairing code however the user typed it — lowercase, spaces, no
 * dash. The code is displayed as `XXXX-XXXX`; refusing `xxxxxxxx` would fail
 * a user for a formatting detail they were never told mattered.
 */
export function normalizeUserCode(input: string): string {
  const bare = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}
