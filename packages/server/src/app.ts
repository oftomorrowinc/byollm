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
  type Audience,
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
  readonly audience?: Audience;
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
    purpose: true,
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

    /**
     * The delivery's dependencies — and on the cloud lane, one fewer.
     *
     * `runnerAvailability` refuses on the cloud lane, deliberately: it counts
     * runners in this site's own store, devices there pair with the relay
     * instead, and it spent a release reporting `no-runner-paired` with
     * confidence for every cloud-lane app that asked.
     *
     * The refusal shipped and this wrapper kept calling it. Delivery asks
     * every 500ms, so `job.result()` threw on its first poll for every
     * cloud-lane site — found by Kevin, on the ordinary consumer loop that
     * none of our own proofs ran.
     *
     * **The law it earned: when you make a function refuse, grep its callers
     * first.** We audited what branched on the untrusted flag and never
     * audited this method's internal callers. A refusal aimed at outsiders
     * that your own loop trips over is a crash wearing a principle.
     *
     * So the question is not asked. Delivery gets no availability instrument
     * on a lane where nothing can answer, rather than an instrument that
     * throws and a `catch` upstream pretending that means "keep waiting".
     */
    const deps: PollingDeliveryDeps = {
      ...(options.noRunnerGraceMs === undefined
        ? {}
        : { graceMs: options.noRunnerGraceMs }),
      read: (jobId) => this.result(jobId),
      ...(this.cloud !== undefined
        ? {}
        : { availability: this.#availabilityFor() }),
    };
    this.#delivery = options.delivery?.(deps) ?? new PollingDelivery(deps);
  }

  /**
   * The no-runner instrument, for a lane that can actually see runners.
   *
   * A method rather than an inline closure so the branch above reads as one
   * decision — whether this deployment has the instrument at all — instead of
   * a conditional wrapped around thirty lines of body.
   */
  #availabilityFor() {
    return async (jobId: string) => {
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
    };
  }

  /**
   * Enqueue a job.
   *
   * `audience` defaults to `self` — the safe direction. Widening it means the
   * result comes back marked untrusted (see {@link ByollmApp.result}), and
   * the app is obliged to disclose that to whoever reads it.
   */
  async enqueue<K extends JobKind>(input: EnqueueInput<K>): Promise<JobHandle> {
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

    /**
     * `audience` is not a fact a cloud-lane site holds — so it may not state
     * one.
     *
     * Who may serve a job is decided by the person: their mapping names a
     * service and its owner, that owner's offer scope says who the service
     * serves, and the hub holds both at claim. The site's declaration was a
     * third vote cast by the one party the disclosure fence forbids from
     * knowing the answer.
     *
     * Which is exactly how its default came to disable the headline feature
     * in silence. It defaults to `private` — own devices only — so a site that
     * simply never mentioned it broke team sharing for every user who had a
     * team, while working perfectly for everyone testing alone. **A
     * declaration required from the party that cannot know is a default in
     * disguise.**
     *
     * Refused rather than ignored, by this method's own rule two paragraphs
     * up: an ignored option is a job that runs differently than asked with
     * nothing to see. The remedy travels with the refusal, because a caller
     * who set it was trying to express something real and deserves to know
     * where that decision now lives.
     */
    if (this.cloud !== undefined && input.audience !== undefined) {
      throw new Error(
        "enqueue does not take `audience` on the cloud lane. Who may serve a " +
          "job is derived from the person's own mapping — the service they " +
          "chose, its owner, and that owner's sharing — which your site is " +
          "not told and cannot compute. Remove `audience`; ask for the kind " +
          "and the purpose, and their decision does the rest.",
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
        /**
         * Derived here, because on the cloud lane it is derivable and nowhere
         * else knows the lane.
         *
         * Refusing the site's declaration is only half of "derived, never
         * declared" — the stub still carries an audience to the relay, and a
         * store that defaults it to `private` would keep every cloud job
         * private no matter who was forbidden from saying so. The half that
         * fixes anything is this one.
         *
         * `team` is the value that defers: it says a device whose owner
         * admits this person may serve, and the hub then decides whether one
         * does, from the mapping the person authored, its service's owner,
         * that owner's offer scope, and the roster. Nothing is widened by
         * saying it — both axes still have to agree, and the owner's scope is
         * the other axis.
         *
         * Direct mode keeps the store's `private` default: there is no
         * control plane there to derive from, and owner-only is the ruling.
         */
        ...(this.cloud === undefined ? {} : { audience: "team" as const }),
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
    /**
     * On the cloud lane this cannot see, so it does not answer.
     *
     * It counts runners in *this site's own store*. In direct mode that is
     * the whole world — devices pair with the site. On the cloud lane they
     * pair with the relay, nothing ever writes a runner here, and the honest
     * count is not zero but unknown.
     *
     * It reported zero, as `no-runner-paired` with `candidates: 0`, for every
     * cloud-lane app that ever called it. A teammate using a shared device
     * was told no device was paired to her account — true, irrelevant, and
     * rendered as advice to go and install software she did not need.
     *
     * **An instrument that cannot see must refuse, not report zero.** A wrong
     * answer given confidently is worse than no answer, and this one was
     * confident, specific and false all at once.
     */
    if (this.cloud !== undefined) {
      throw new Error(
        "runnerAvailability cannot answer on the cloud lane. It counts " +
          "runners this site knows about, and on the cloud lane devices pair " +
          "with the relay rather than with you — so the answer would be " +
          "`none` whatever the truth is. Enqueue the job: the result says " +
          "whether it ran, and the person's own dashboard says why not.",
      );
    }

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
    let lastRefusal: MatchRefusal | undefined;
    /**
     * Every advertised service for this kind, not one chosen here.
     *
     * This used to pick a single row — the one a job named, or the one the
     * owner had made the default — because a site could name a service and a
     * router matched on the name. Amendment L removed the naming, so there is
     * no row to prefer: availability is now "does *anything* this device
     * offers for this kind admit this person", which is also the honest
     * question, since which service actually answers is resolved from the
     * person's own mapping at claim.
     */
    for (const runner of live) {
      for (const capability of runner.capabilities.filter(
        (c) => c.kind === query.kind,
      )) {
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
            admits: () => true,
          },
        );
        if (match.ok) admitted += 1;
        else lastRefusal = match.refusal;
      }
    }

    if (capable === 0) {
      // Ordered most specific first, because each sends the reader somewhere
      // different: a name that cannot serve them, a decision the device's
      // owner has not made, or nothing installed at all.
      return {
        available: false,
        reason: "no-matching-capability",
        candidates: 0,
      };
    }
    if (admitted === 0) {
      // Something serves it and nothing may serve *this requester*. When the
      // block is the device owner's own setting, that is the
      // defaults-meet-audiences corner — every service for this kind is one
      // this person can never use — and it is worth its own word, because
      // "nobody is admitted" reads as a
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
        reason: ownersDoing ? "default-unusable" : "audience-admits-nobody",
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
