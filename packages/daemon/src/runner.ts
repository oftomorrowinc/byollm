import {
  type Succession,
  RETIREMENT_WINDOW_MS,
  walkSuccession,
  ENVELOPE_MAX_AGE_MS,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sizeClassCeiling,
  fingerprint,
  verifyPublicIdentity,
  type ClaimedStub,
  type JobPayload,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
  REFUSAL_MESSAGES,
  matchAudience,
  type Capability,
  type ClaimedJob,
  type RunMetadata,
  type SealedOutcome,
  type JobOutcome,
  ROSTER_MAX_AGE_MS,
  type RosterRefusal,
  type SignedRoster,
  verifyRoster,
} from "@byollm/protocol";
import type { Allowlist } from "./allowlist.js";
import { createBackend, type Backend } from "./backends/index.js";
import type { Budgets } from "./budgets.js";
import { ClientError, type ProtocolClient } from "./client.js";
import { composePrompt } from "./compose.js";
import type { LoadedConfig, ResolvedRoute } from "./config.js";
import { writeHealth } from "./health.js";
import type { IngressLog } from "./ingress.js";
import { estimateCents, type SpendLedger } from "./spend.js";

/** What the daemon is currently doing, for `byollm status`. */
export interface RunnerStatus {
  readonly origin: string;
  readonly owner: string;
  readonly runnerId: string;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly activeJobs: number;
  readonly capabilities: readonly Capability[];
  /** Set when the last server contact failed — one of the four truths. */
  readonly lastError?: string;
  readonly completed: number;
  readonly refused: number;
}

export interface RunnerOptions {
  readonly client: ProtocolClient;
  readonly runnerId: string;
  readonly owner: string;
  readonly daemonVersion: string;
  readonly loaded: LoadedConfig;
  readonly allowlist: Allowlist;
  /**
   * The control plane's roster-signing key, pinned at pairing — Amendment G.
   *
   * Absent for a direct-mode server, which has no control plane, and for any
   * pairing made before this existed. Absent means no roster is honoured:
   * there is nothing to check a signature against, and accepting one anyway
   * would trust whoever delivered it.
   */
  readonly controlPlanePublic?: string | undefined;
  readonly budgets: Budgets;
  /** Tracks money spent on other people's work, for metered backends. */
  readonly spend: SpendLedger;
  readonly ingress: IngressLog;
  /**
   * How this daemon opens work sealed to it, and what it checks it against.
   *
   * `sitePinned` is the identity taken at pairing (byollm_009 §5). Verifying
   * against it — rather than against anything the envelope claims — is what
   * makes a relay unable to substitute work: it can produce an envelope this
   * machine can open, but not one signed by the site.
   */
  readonly identity?: {
    keys(): Promise<StoredKeys>;
    /**
     * Every site this machine is paired with, keyed by the site's identity
     * key id — cloud_009 §5.
     *
     * The same id `stub.site` carries (Amendment A §A.3), so resolving a
     * job's site is a map read rather than a join against a second
     * namespace.
     *
     * The set the *upstream* says this pairing covers, refreshed on every
     * heartbeat (cloud_009 §5). `sitePinned` is gone: one pairing covers an
     * upstream rather than a site, and two answers to "which key opens this"
     * is this project's most repeated bug.
     */
    readonly sites: ReadonlyMap<string, PublicIdentity>;
    /**
     * Every site this machine has ever *approved*, with the key it was
     * approved under — including sites whose consent has since ended.
     *
     * The pinning half that the site set alone cannot carry. `sites` follows
     * consent, so a site that leaves it is gone; if that were the only
     * record, an upstream could drop an id and re-offer it under a key of
     * its own choosing and the daemon would read it as somebody new. This map
     * only grows, so the second offer is compared against the first.
     */
    readonly known?: ReadonlyMap<string, PublicIdentity>;
  };
  /** Heartbeat cadence before jitter. */
  readonly heartbeatMs?: number;
  /**
   * Where to record how the upstream conversation is going.
   *
   * Optional because a test or an embedder driving the loop by hand has no
   * `~/.byollm` to write into, and a diagnostic that requires one would make
   * the daemon harder to run than it needs to be.
   */
  readonly healthPath?: string;
  readonly now?: () => number;
  /** Notified on every state change, so the CLI can render progress. */
  readonly onEvent?: (event: RunnerEvent) => void;
  /** Injectable backend factory, so tests need no real model server. */
  readonly backendFactory?: (route: ResolvedRoute) => Backend;
}

export type RunnerEvent =
  | { readonly type: "heartbeat"; readonly capabilities: number }
  /** A disclosure went stale; the user has something to read — finding 48. */
  | { readonly type: "awaiting-consent"; readonly sites: readonly string[] }
  | { readonly type: "consent-resumed" }
  /** A pinned site's encryption key moved under its identity — refused. */
  | { readonly type: "site-key-changed"; readonly site: string }
  /**
   * A site this machine has never approved arrived on the heartbeat. Nothing
   * is served for it until somebody at this keyboard says so — V1-1.
   */
  /**
   * A service said it is not signed in, so it is no longer advertised.
   *
   * Loud because the failure it replaces was silent: the health check runs
   * `--version`, which needs no credentials, so a signed-out CLI reported
   * healthy and every job failed. One notice, on the first job that proves it.
   */
  | {
      readonly type: "service-not-signed-in";
      readonly service: string;
      readonly detail: string;
    }
  /**
   * A roster arrived and was not honoured.
   *
   * Loud, because the consequence is a narrower device and the cause is
   * invisible from the outside: somebody whose teammate's jobs stopped
   * routing has no other way to learn that the document saying they may was
   * refused, and why.
   */
  | {
      readonly type: "roster-refused";
      readonly refusal: RosterRefusal;
      readonly issuedAt: number;
    }
  | {
      readonly type: "site-awaiting-approval";
      readonly site: string;
      readonly fingerprint: string;
    }
  /**
   * A site proved continuity from a key this machine already approved, and the
   * approval moved with it — byollm_009 Amendment C.
   *
   * Loud by design (C.5, ruling 3). Rotation is automatic because requiring a
   * second ceremony would train people to approve keys they cannot check, and
   * the price of automatic is that it is never silent: a rotation that
   * produced no line anywhere would make "your machine only serves keys you
   * approved" quietly untrue.
   */
  | {
      readonly type: "site-rotated";
      readonly site: string;
      readonly from: string;
      readonly fromFingerprint: string;
      readonly fingerprint: string;
      /** Every key id passed through, oldest first. */
      readonly path: readonly string[];
    }
  /** A site the upstream offered whose own account of itself did not add up. */
  | {
      readonly type: "site-refused";
      readonly site: string;
      readonly reason: string;
    }
  | { readonly type: "claimed"; readonly jobId: string; readonly kind: string }
  | {
      readonly type: "refused";
      readonly jobId: string;
      readonly reason: string;
    }
  | {
      readonly type: "finished";
      readonly jobId: string;
      readonly outcome: string;
      readonly durationMs: number;
    }
  | { readonly type: "revoked" }
  /**
   * Nothing is consented for this machine right now — V1-2. Not revocation:
   * the pairing stands, the pins stand, and the loop keeps beating.
   */
  | { readonly type: "serving-nothing" }
  | { readonly type: "error"; readonly message: string };

const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * Whether two accounts of a site are the same key material.
 *
 * All three fields, not the encryption key alone: the identity is what a
 * fingerprint is taken of, the encryption key is what work is sealed to, and
 * the signature is what ties them together. A comparison that skipped any of
 * them would call two different keys the same.
 */
function sameKey(a: PublicIdentity, b: PublicIdentity): boolean {
  return (
    a.identity === b.identity &&
    a.encryption === b.encryption &&
    a.encryptionSig === b.encryptionSig
  );
}

/**
 * The daemon's loop: heartbeat, claim, execute, report.
 *
 * Everything that makes the daemon a *trust anchor* rather than a worker
 * happens in {@link Runner.admit} and {@link Runner.runJob} — the local
 * audience check, the budget check, and the ingress write that precedes
 * execution. The loop itself is deliberately dull.
 */
export class Runner {
  readonly #options: RunnerOptions;
  readonly #backends = new Map<string, Backend>();
  /**
   * Jobs in flight, by job id → the grant and how to stop it.
   *
   * **Keyed by lease id, not by job id** — V1-3. A job id is chosen by its
   * site, so a daemon serving two sites can hold two different jobs called
   * `job_1`; keyed by id, the second overwrote the first, and the first lost
   * the `AbortController` that could stop it and the lease id that could
   * release it. Its lease then lapsed mid-run, the upstream offered the work
   * to somebody else, and the same prompt ran twice on somebody's machine.
   *
   * The lease id is the unique grant (byollm_009 §4.2, `Lease.id`), which is
   * also why every lease-scoped call names it: a release that names only the
   * job releases whatever lease exists when it arrives, which for a replayed
   * request is not the one this daemon meant.
   */
  readonly #active = new Map<
    string,
    { controller: AbortController; jobId: string; site: string | undefined }
  >();

  /**
   * Grants abandoned because their site's consent ended mid-run — V1-7.
   *
   * Held rather than acted on immediately: the backend call is already being
   * aborted, and what happens next belongs where the job finishes, once.
   */
  readonly #abandoned = new Set<string>();
  readonly #now: () => number;
  #capabilities: Capability[] = [];
  #paused = false;
  #revoked = false;
  #awaitingConsent = "";
  #servingNothing = false;
  #stopped = false;
  #consecutiveFailures = 0;
  /**
   * Services that answered "not signed in" — withdrawn until proven otherwise.
   *
   * In memory rather than on disk: a restart re-runs the start-up canary,
   * which is a better answer than a remembered verdict about credentials that
   * may since have been fixed. Nothing here should outlive the process that
   * observed it.
   */
  readonly #unauthenticated = new Set<string>();

  /**
   * The roster this device holds — Amendment G.
   *
   * Held verified: nothing reaches this field that did not carry a signature
   * from the key pinned at pairing. A relay can withhold it, which narrows
   * this device, and can forge nothing.
   */
  #roster: SignedRoster | undefined;
  /** Why the last roster was refused, if it was. For status, not for callers. */
  #rosterRefusal: RosterRefusal | undefined;
  #lastUpstreamError: string | undefined;
  #lastError: string | undefined;
  #completed = 0;
  #refused = 0;

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    // Copied, not aliased: the pairing's map is what was on disk, and this
    // one is what the upstream last said. Sharing them would let a heartbeat
    // rewrite a file nobody wrote.
    this.#sites = new Map(options.identity?.sites ?? []);
    // Everything on disk was approved once: the sites in a pairing came
    // through `connect`'s fingerprint compare, and the `known` map holds the
    // ones whose consent has since ended. Seeded from both so a daemon that
    // restarts asks nobody to re-approve what they already did.
    this.#known = new Map([
      ...(options.identity?.known ?? []),
      ...(options.identity?.sites ?? []),
    ]);
  }

  /** The sites this daemon holds pins for, so the CLI can persist changes. */
  get sites(): ReadonlyMap<string, PublicIdentity> {
    return this.#sites;
  }

  /** Every site ever approved here, so the CLI can persist the tombstones. */
  get known(): ReadonlyMap<string, PublicIdentity> {
    return this.#known;
  }

  /**
   * Superseded ids still being served, and until when — Amendment C.
   *
   * Exposed for the same reason `known` is: what this machine is willing to
   * verify against is a thing a person should be able to read, and a window
   * nobody can see is a window nobody can check has closed.
   */
  get retiring(): ReadonlyMap<string, number> {
    return this.#retiring;
  }

  /**
   * Sites the upstream offered that nobody here has approved yet.
   *
   * Persisted by the CLI so `byollm sites` can show their fingerprints and
   * `byollm approve` can pin the key the person was shown — an approval that
   * re-fetched the key from the upstream would be approving a different
   * question than the one on screen.
   */
  get pending(): ReadonlyMap<string, PublicIdentity> {
    return this.#pending;
  }

  /**
   * Take approvals recorded on disk by a `byollm approve` run.
   *
   * `byollm approve` is a different process — the daemon is in the middle of
   * a run loop — so approval arrives through the pairings file rather than a
   * call. Re-checked here rather than trusted: this reads a file, and a file
   * on a shared machine is not a smaller thing to verify than a heartbeat.
   */
  applyApprovals(known: ReadonlyMap<string, PublicIdentity>): void {
    for (const [id, site] of known) {
      if (this.#known.has(id)) continue;
      if (!verifyPublicIdentity(site) || keyId(site.identity) !== id) continue;
      this.#known.set(id, site);
      const offered = this.#pending.get(id);
      // Serve it now only if the key that was approved is the key the
      // upstream is currently offering. If they differ, nothing is served and
      // the next heartbeat says `site-key-changed` — which is the true
      // sentence about a key that moved between approval and use.
      if (offered && sameKey(offered, site)) this.#sites.set(id, site);
      this.#pending.delete(id);
      this.#announced.delete(id);
    }
  }

  status(): RunnerStatus {
    return {
      origin: this.#options.client.origin,
      owner: this.#options.owner,
      runnerId: this.#options.runnerId,
      paused: this.#paused,
      revoked: this.#revoked,
      activeJobs: this.#active.size,
      capabilities: [...this.#capabilities],
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      completed: this.#completed,
      refused: this.#refused,
    };
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  /**
   * Build the capability matrix: owner config intersected with what is
   * actually reachable and healthy right now
   * ({@link MUSTS.CAPABILITY_IS_DETECTED}).
   *
   * A configured route whose backend is down simply does not appear. The
   * daemon then receives no work for it, which is the correct outcome and one
   * the owner can see in `byollm status`.
   */
  async detectCapabilities(
    options: {
      /**
       * Also spend one real call per credentialed backend — ruled 2026-08-25.
       *
       * **Start and enablement only.** `#tick()` never passes this: a canary
       * on the polling loop would spend a subscription call every heartbeat,
       * which is a standing cost to answer a question whose answer changes
       * about once a month.
       *
       * The pairing is deliberate. This catches a signed-out backend before
       * any of somebody's work is refused; the `unauthorized` path catches
       * credentials that expire while the daemon runs, and costs nothing. Two
       * legs, and neither is a poll.
       */
      canary?: boolean;
    } = {},
  ): Promise<Capability[]> {
    const capabilities: Capability[] = [];

    /**
     * One probe per service — byollm_016.
     *
     * Detection used to run per route, so a service answering two kinds was
     * asked twice. That doubles the network cost of every heartbeat, and it
     * lets one service return two different answers about itself in the same
     * tick — a machine that is half-advertised for reasons nobody can
     * reconstruct. A service is one thing; it is asked once.
     *
     * The model check moves with it: in this shape the model belongs to the
     * service, so "does the server actually have it" is the same question for
     * every kind that service answers.
     */
    const probed = new Map<string, boolean>();

    for (const route of this.#options.loaded.routes) {
      // Withdrawn on an auth failure, before the backend is asked anything.
      // The probe would say healthy — `--version` needs no credentials — which
      // is the whole reason this set exists.
      if (this.#unauthenticated.has(route.service)) continue;
      let usable = probed.get(route.service);
      if (usable === undefined) {
        const backend = this.#backendFor(route);
        const health = await backend.health();
        // If the backend enumerates its models, honour that: advertising a
        // model the server does not have would be advertising a lie.
        usable =
          health.healthy &&
          (health.models.length === 0 ||
            modelPresent(health.models, route.model));

        // The credentialed check, when asked for and when the backend has one.
        // Only after `health` passed — there is no sense spending a call on a
        // binary that is not there.
        if (usable && options.canary === true && backend.canary !== undefined) {
          const proof = await backend.canary(route.model);
          if (!proof.healthy) {
            usable = false;
            this.#unauthenticated.add(route.service);
            this.#options.onEvent?.({
              type: "service-not-signed-in",
              service: route.service,
              detail: proof.detail ?? "the check call did not succeed",
            });
          }
        }
        probed.set(route.service, usable);
      }
      if (!usable) continue;

      capabilities.push({
        kind: route.kind,
        service: route.service,
        // Which row an unselected job takes, from the route rather than
        // asserted — byollm_016 Phase B.
        //
        // This read `isDefault: true` for every row, under a comment saying
        // Phase A advertises exactly one service per kind so every advertised
        // row is its kind's default — and warning, in its last sentence, that
        // Phase B would advertise the whole menu and make that untrue. Phase B
        // shipped the menu and left the line alone, so a device offering four
        // services for `llm.generate` advertised four defaults.
        //
        // Nothing mis-routed: the daemon picks the default from its own config
        // and always did. What was wrong is the **advertisement** — and this
        // is the field byollm_016 added expressly so Phase B could grow the
        // menu without any consumer re-deriving what "default" means. A guard
        // field that lies is worse than none, because the inference it
        // replaced at least matched the data.
        isDefault: route.isDefault,
        backendId: route.backendId,
        backendClass: route.backendClass,
        model: route.model,
        offerScope: route.offerScope,
      });
    }

    this.#capabilities = capabilities;
    return capabilities;
  }

  #backendFor(route: ResolvedRoute): Backend {
    const key = `${route.service}:${route.backendId}`;
    let backend = this.#backends.get(key);
    if (!backend) {
      backend =
        this.#options.backendFactory?.(route) ??
        createBackend(route.backendId, {
          baseUrl: route.baseUrl,
          apiKeyEnv: route.apiKeyEnv,
        });
      this.#backends.set(key, backend);
    }
    return backend;
  }

  /**
   * Has this route spent the owner's daily ceiling on other people's work?
   *
   * Only meaningful for `metered` routes; `free` and `subscription` never
   * reach here in a way that matters, because the matcher refuses them for
   * other reasons first ({@link MUSTS.METERED_REQUIRES_CEILING}).
   */
  #spendCeilingReached(route: ResolvedRoute): boolean {
    if (route.cost !== "metered") return false;
    return this.#options.spend.hasReachedCeiling(
      route.service,
      route.spendDailyCapCents,
      this.#now(),
    );
  }

  /**
   * The route a job takes — byollm_016 Phase B, both sides of it.
   *
   * Was `routes.find((r) => r.kind === kind)`, which was correct while a kind
   * had exactly one route and became a coin-flip the moment the menu started
   * travelling: it would have handed an unselected job to whichever service
   * sorted first, which is the guess `withheld` exists to refuse.
   *
   * A named service is matched exactly and never approximately. `undefined`
   * here means refuse — not fall back to the default — because serving a
   * selection from something else is the substitution `NO_PAYLOAD_ROUTING`
   * forbids, and the daemon is the party that owns that rule. The hub already
   * matched on the same pair; this is the second check, for the same reason
   * the allowlist is checked twice.
   */
  #routeFor(kind: string, service?: string): ResolvedRoute | undefined {
    const routes = this.#options.loaded.routes;
    if (service !== undefined) {
      return routes.find(
        (route) => route.kind === kind && route.service === service,
      );
    }
    return routes.find((route) => route.kind === kind && route.isDefault);
  }

  /**
   * Decide whether this machine will run a claimed job.
   *
   * The server already applied its own version of the audience rules, and
   * that is not what this checks. This is the daemon enforcing against the
   * server: the local `named` allowlist
   * ({@link MUSTS.NAMED_LOCAL_ALLOWLIST}), the subscription self-lock, and
   * the owner's community budgets. A job that fails here is released with
   * reason `refused`, which the server remembers so it is never offered back.
   */
  admit(job: ClaimedStub): { ok: true } | { ok: false; reason: string } {
    // Before anything else, and before a payload is fetched: is this a site
    // this machine serves? `#pinFor` asks the same question at seal time,
    // which is *after* a backend has been paid to answer a prompt from a site
    // nobody here approved. Asked here, the answer costs a release.
    if (this.#options.identity && !this.#sites.has(job.site)) {
      return {
        ok: false,
        reason: this.#pending.has(job.site)
          ? `this device has not approved site ${job.site} yet — ` +
            "run `byollm sites` to see it and `byollm approve` to allow it"
          : `this device does not serve site ${job.site} ` +
            `(serving ${[...this.#sites.keys()].sort().join(", ") || "nothing"})`,
      };
    }

    const route = this.#routeFor(job.kind, job.service);
    if (!route) {
      // An unknown or unrouted kind is refused, never guessed
      // ({@link MUSTS.KIND_TYPED_ONLY}).
      return { ok: false, reason: REFUSAL_MESSAGES["no-capability"] };
    }

    const match = matchAudience(
      {
        owner: job.owner,
        audience: job.audience,
        // No `audienceAllow`: it is not on the wire any more (cloud_008
        // §0.2), and this is the branch that made it look load-bearing. It
        // narrowed a decision `locallyAllows` below already owns — the site
        // could only ever agree with the daemon's own list or contradict it,
        // and nothing wrote down which won.
      },
      {
        owner: this.#options.owner,
        offerScope: route.offerScope,
        cost: route.cost,
        spend: {
          acknowledged: route.spendAcknowledged,
          ceilingReached: this.#spendCeilingReached(route),
        },
        // The daemon's own list — the whole point of Rev 1 §B.
        locallyAllows: this.#options.allowlist.predicateFor(
          this.#options.client.origin,
        ),
      },
    );
    if (!match.ok) {
      return { ok: false, reason: REFUSAL_MESSAGES[match.refusal] };
    }

    if (job.owner !== this.#options.owner) {
      // From the stub's bucket, because admission happens before the payload
      // is fetched. The ceiling is charged rather than a midpoint: refusing
      // slightly too eagerly is the safe direction for someone else's work on
      // the owner's machine.
      const decision = this.#options.budgets.check(
        this.#now(),
        sizeClassCeiling(job.sizeClass),
      );
      if (!decision.ok) return { ok: false, reason: decision.detail };
    }

    return { ok: true };
  }

  /**
   * Execute one admitted job.
   *
   * Order is load-bearing: the ingress write is awaited *before* the backend
   * is touched ({@link MUSTS.INGRESS_LOGGED_BEFORE_EXECUTION}), so a job that
   * hangs the machine still leaves a record of what it was.
   */
  async runJob(job: ClaimedJob): Promise<JobOutcome> {
    const route = this.#routeFor(job.kind, job.service);
    if (!route) {
      return {
        outcome: "error",
        code: "no-capability",
        message: "this device has no route for that job kind",
        retryable: false,
      };
    }

    const controller = new AbortController();
    this.#active.set(job.lease.id, {
      controller,
      jobId: job.id,
      site: job.site,
    });

    const prompt = composePrompt(job);
    const community = job.owner !== this.#options.owner;
    const limits = this.#options.loaded.config;

    await this.#options.ingress.recordPrompt({
      at: this.#now(),
      origin: this.#options.client.origin,
      jobId: job.id,
      ...(job.site === undefined ? {} : { site: job.site }),
      kind: job.kind,
      audience: job.audience,
      owner: job.owner,
      backendId: route.backendId,
      backendClass: route.backendClass,
      model: route.model,
      prompt,
    });

    if (community) await this.#options.budgets.record(this.#now());

    try {
      const backend = this.#backendFor(route);
      const result = await backend.execute({
        prompt,
        model: route.model,
        // Community jobs run under the owner's tighter ceiling.
        timeoutMs: community
          ? Math.min(
              limits.community.maxWallClockMs,
              limits.limits.maxWallClockMs,
            )
          : limits.limits.maxWallClockMs,
        maxOutputBytes: community
          ? Math.min(
              limits.community.maxOutputBytes,
              limits.limits.maxOutputBytes,
            )
          : limits.limits.maxOutputBytes,
        signal: controller.signal,
      });

      /**
       * A service that cannot authenticate stops being advertised, after one
       * job — ruled 2026-08-25.
       *
       * The free half of closing healthy-but-every-job-fails. The paid half is
       * a canary at start; this costs nothing and catches the case the canary
       * cannot: credentials that expire while the daemon is running.
       *
       * One failure, not a streak. A backend that says "not signed in" is not
       * flaky — it is telling us a fact that will hold until somebody logs in,
       * and every further job spent confirming it is somebody's work refused
       * for a reason we already knew.
       */
      if (!result.ok && result.code === "unauthorized") {
        this.#unauthenticated.add(route.service);
        this.#options.onEvent?.({
          type: "service-not-signed-in",
          service: route.service,
          detail: result.message,
        });
      }

      const outcome: JobOutcome = result.ok
        ? { outcome: "ok", text: result.text }
        : result.code === "canceled"
          ? { outcome: "canceled" }
          : {
              outcome: "error",
              code: result.code,
              message: result.message,
              retryable: result.retryable,
            };

      await this.#options.ingress.recordOutcome({
        at: this.#now(),
        jobId: job.id,
        ...(job.site === undefined ? {} : { site: job.site }),
        outcome: outcome.outcome,
        durationMs: result.durationMs,
        outputChars: result.ok ? result.text.length : 0,
        ...(result.ok ? {} : { detail: result.message }),
      });

      // Community work on a metered backend spends the owner's money, so it
      // goes on the ledger the ceiling is checked against. Own work is not
      // counted: their machine, their key, their call.
      if (community && route.cost === "metered") {
        await this.#options.spend.record(
          route.service,
          estimateCents(
            prompt.length,
            result.ok ? result.text.length : 0,
            route.spendCentsPerMillionTokens,
          ),
          this.#now(),
        );
      }

      this.#completed += 1;
      this.#options.onEvent?.({
        type: "finished",
        jobId: job.id,
        outcome: outcome.outcome,
        durationMs: result.durationMs,
      });
      return outcome;
    } finally {
      this.#active.delete(job.lease.id);
    }
  }

  /**
   * Abort one grant's in-flight backend call ({@link MUSTS.CANCEL_HONORED}).
   *
   * By lease, because that is what a cancel names — V1-3. Cancelling by job
   * id aborted whichever job this daemon happened to have filed under that
   * name, which for two sites that chose the same id is a coin flip: one
   * site's cancel stopped another site's work and left its own running.
   */
  cancelLease(leaseId: string): void {
    this.#active.get(leaseId)?.controller.abort();
  }

  /** Abort everything — revocation, or shutdown. */
  cancelAll(): void {
    for (const { controller } of this.#active.values()) controller.abort();
  }

  /**
   * Run until stopped.
   *
   * Resumable and idempotent by job id: a daemon that dies mid-job loses
   * nothing, because the server reclaims the lease and offers the job again.
   */
  async run(signal: AbortSignal): Promise<void> {
    const heartbeatMs = this.#options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    while (!signal.aborted && !this.#stopped) {
      try {
        await this.tick();
        this.#lastError = undefined;
      } catch (error) {
        this.#lastError =
          error instanceof Error ? error.message : "unknown error";
        this.#options.onEvent?.({
          type: "error",
          message: this.#lastError,
        });
        if (this.#revoked) return;
        const backoff =
          error instanceof ClientError && error.retryAfter !== undefined
            ? error.retryAfter * 1000
            : heartbeatMs;
        await sleep(backoff, signal);
        continue;
      }
      // Jitter so a fleet of daemons does not synchronise into a thundering
      // herd against one server.
      await sleep(heartbeatMs * (0.85 + Math.random() * 0.3), signal);
    }
  }

  /**
   * Note a refusal that means the relationship is over.
   *
   * The **only** way this daemon learns it was revoked — V1-2. It used to
   * infer revocation from an empty site set, which made a control-plane
   * glitch indistinguishable from somebody's decision and cost the machine
   * its pinned keys. An upstream that means "stop" says so with a code.
   *
   * Handled here rather than only in {@link Runner.run} because `tick` is
   * what tests and embedders call: a rule that only holds when the loop is
   * driving it is a rule with a shape somebody will step around.
   */
  #revokedBy(error: unknown): boolean {
    if (!(error instanceof ClientError) || error.kind !== "revoked") {
      return false;
    }
    this.#revoked = true;
    this.#stopped = true;
    this.cancelAll();
    this.#options.onEvent?.({ type: "revoked" });
    return true;
  }

  /** One heartbeat-and-claim cycle. Exposed so tests can step deterministically. */
  async tick(): Promise<void> {
    try {
      await this.#tick();
      // A cycle that completed is the only thing that clears the count. It is
      // written on the transition rather than every beat, so a healthy daemon
      // is not rewriting a file every ten seconds to say nothing changed.
      if (this.#consecutiveFailures > 0) {
        this.#consecutiveFailures = 0;
        await this.#recordHealth();
      }
    } catch (error) {
      // Revocation is an answer, not a failure. Swallowed once recorded, so
      // that a caller stepping this loop by hand — a test, an embedder, the
      // conformance kit — sees a daemon that has stopped rather than an
      // exception it has to know to interpret. Everything else still throws.
      if (this.#revokedBy(error)) return;
      // Counted before it is rethrown. One refusal is noise — a rolling
      // deploy, a dropped connection — and forty in a row is a device that
      // has stopped participating and does not know it. Only a count tells
      // those apart, so something has to keep one.
      this.#consecutiveFailures += 1;
      this.#lastUpstreamError =
        error instanceof Error ? error.message : "unknown error";
      await this.#recordHealth();
      throw error;
    }
  }

  async #recordHealth(): Promise<void> {
    const path = this.#options.healthPath;
    if (path === undefined) return;
    await writeHealth(path, {
      at: this.#now(),
      consecutiveFailures: this.#consecutiveFailures,
      ...(this.#lastUpstreamError === undefined
        ? {}
        : { lastError: this.#lastUpstreamError }),
      origin: this.#options.client.origin,
    });
  }

  async #tick(): Promise<void> {
    const capabilities = await this.detectCapabilities();

    const heartbeat = await this.#options.client.heartbeat({
      runnerId: this.#options.runnerId,
      daemonVersion: this.#options.daemonVersion,
      capabilities,
      // What this device could serve and is not, so the surfaces that must
      // explain a missing kind are not all on this machine. The hub decides
      // who is told what; the device only reports.
      withheld: this.#options.loaded.withheld.map((held) => ({
        kind: held.kind,
        claimants: held.services.map((service) => ({
          service,
          offer:
            this.#options.loaded.config.services[service]?.offer ?? "private",
        })),
      })),
      activeLeases: [...this.#active.entries()].map(([leaseId, held]) => ({
        jobId: held.jobId,
        leaseId,
      })),
      paused: this.#paused,
    });

    // The site set, applied — cloud_008 finding 59.
    //
    // A site that left the set is revoked *for that site*: its pin goes and
    // the others stay. Revocation used to be a boolean that stopped the
    // daemon and dropped its whole pairing, so one site's revocation ended a
    // machine's relationship with every other site it served.
    //
    // A key that *changed* for a site still in the set is refused rather than
    // replaced. The map is keyed by identity key id, so a changed identity
    // arrives as a different entry — this is the encryption key moving under
    // an identity somebody already compared a fingerprint of, which pinning
    // exists to refuse. Amendment A.3.1's rotation is an explicit path, not
    // a silent swap.
    this.#applySites(heartbeat.sites, heartbeat.successions);
    // Verified before it is held, and held only if it verifies — Amendment G.
    this.#applyRoster(heartbeat.roster);

    // Announced *after* the set is applied — V1-17. The CLI persists
    // `runner.sites` when it sees this event, so firing it first wrote the
    // previous heartbeat's set to disk: every change reached the file one
    // beat late, and the last change before a shutdown never reached it at
    // all.
    this.#options.onEvent?.({
      type: "heartbeat",
      capabilities: capabilities.length,
    });

    // Nothing will be offered for these, and the reason is not a fault —
    // finding 48. Said once per transition rather than every few seconds: a
    // daemon that repeats itself on a five-second heartbeat is a daemon
    // nobody reads.
    const waiting = heartbeat.awaitingConsent.join(",");
    if (waiting !== this.#awaitingConsent) {
      this.#awaitingConsent = waiting;
      if (waiting === "") {
        this.#options.onEvent?.({ type: "consent-resumed" });
      } else {
        this.#options.onEvent?.({
          type: "awaiting-consent",
          sites: [...heartbeat.awaitingConsent],
        });
      }
    }

    // A job the server says we lost must be abandoned, not finished
    // ({@link MUSTS.LEASE_HONORED}).
    for (const grant of heartbeat.lost) this.cancelLease(grant.leaseId);
    for (const grant of heartbeat.cancel) this.cancelLease(grant.leaseId);

    // An empty set is **not** revocation — V1-2.
    //
    // It used to be read as one: the daemon stopped for good, cancelled
    // everything and dropped its pairing, which meant a projection that
    // arrived empty for a moment cost this machine every pin it held. Absence
    // of consent and withdrawal of consent are different facts, and only the
    // second is somebody's decision. Revocation now arrives the one way it
    // can be certain — the upstream refusing the call with `revoked`, handled
    // in the loop above.
    //
    // The leases named above are still abandoned: whether or not consent has
    // ended, work with no route to return to is work that should stop.
    if (Object.keys(heartbeat.sites).length === 0) {
      if (!this.#servingNothing) {
        this.#servingNothing = true;
        this.#options.onEvent?.({ type: "serving-nothing" });
      }
      // And the claim below still goes out. That is the point: asking for
      // work is what tells these two states apart. An upstream that has
      // ended the relationship answers `revoked` and this daemon stops; one
      // that simply has nothing consented answers with no jobs and this
      // daemon keeps its pairing. Inferring either from silence is what V1-2
      // was.
    } else {
      this.#servingNothing = false;
    }

    if (this.#paused || capabilities.length === 0) return;

    const free = this.#options.loaded.config.concurrency - this.#active.size;
    if (free <= 0) return;

    const { jobs } = await this.#options.client.claim({
      runnerId: this.#options.runnerId,
      capabilities,
      max: free,
    });

    // Not awaited: claimed jobs run concurrently up to the owner's limit, and
    // the loop keeps heartbeating so their leases stay alive.
    //
    // The `catch` is load-bearing. Without it, a failure in the background
    // handler — an ingress write that cannot land because the disk is full or
    // the state directory has gone — becomes an unhandled rejection and takes
    // the whole daemon down. The lease lapses instead and the server offers
    // the job again, which is the recovery the protocol is built around.
    for (const job of jobs) {
      void this.#handle(job).catch((error: unknown) => {
        this.#lastError =
          error instanceof Error ? error.message : "unknown error";
        this.#options.onEvent?.({ type: "error", message: this.#lastError });
      });
    }
  }

  async #handle(job: ClaimedStub): Promise<void> {
    this.#options.onEvent?.({
      type: "claimed",
      jobId: job.id,
      kind: job.kind,
    });

    const admission = this.admit(job);
    if (!admission.ok) {
      this.#refused += 1;
      await this.#options.ingress.recordOutcome({
        at: this.#now(),
        jobId: job.id,
        site: job.site,
        outcome: "refused",
        detail: admission.reason,
      });
      this.#options.onEvent?.({
        type: "refused",
        jobId: job.id,
        reason: admission.reason,
      });
      await this.#safely(() =>
        this.#options.client.release({
          runnerId: this.#options.runnerId,
          leases: [{ jobId: job.id, leaseId: job.lease.id }],
          reason: "refused",
        }),
      );
      return;
    }

    // Only now, after this daemon has decided it will run the work, does the
    // payload arrive (byollm_009 §6). A daemon that declines on its own
    // allowlist never receives the prompt at all — which was not true when
    // the payload rode along with the claim.
    const fetched = await this.#fetchWhenSealed(job);
    if (!fetched) return;
    const payload = await this.#openPayload(job, fetched.envelope);

    const route = this.#routeFor(job.kind, job.service);
    const outcome = await this.runJob({ ...job, payload });

    // The site's consent ended while this ran — V1-7. There is nothing to
    // seal to: the pin went with the consent, and an answer sealed to a
    // withdrawn site is an answer nobody may read. The lease goes back so the
    // upstream is not left waiting out a grant nobody will finish.
    if (this.#abandoned.delete(job.lease.id)) {
      await this.#safely(() =>
        this.#options.client.release({
          runnerId: this.#options.runnerId,
          leases: [{ jobId: job.id, leaseId: job.lease.id }],
          reason: "revoked",
        }),
      );
      return;
    }

    const envelope = await this.#sealOutcome(job, outcome, {
      model: route?.model ?? "unknown",
      backendClass: route?.backendClass ?? "http",
      durationMs: 0,
    });

    await this.#safely(() =>
      this.#options.client.result({
        runnerId: this.#options.runnerId,
        jobId: job.id,
        // The grant this work was done under, not merely who did it. A runner
        // id survives a claim-release-reclaim cycle; a lease id is the thing
        // that ended.
        leaseId: job.lease.id,
        envelope,
        disposition: outcome.outcome,
      }),
    );
  }

  /**
   * Seal a finished outcome back to the site that sent the work.
   *
   * The return leg of {@link ByollmRunner.#openPayload}, and it exists for the
   * same reason: an answer is as sensitive as the prompt that produced it. A
   * relay that is denied one and handed the other has been denied nothing.
   *
   * The signature also does work the payload leg does not need. `RESULT_
   * PROVENANCE` says a result is attributable to a device; until now that
   * rested on the request signature, which covers the request and expires with
   * it. This binds the *outcome itself* to the device's key, so what the app
   * eventually reads carries its own proof of who produced it.
   */
  async #sealOutcome(
    job: ClaimedStub,
    outcome: JobOutcome,
    ran: RunMetadata,
  ): Promise<SealedEnvelope> {
    const identity = this.#options.identity;
    if (!identity) {
      // Unreachable in practice, and the reason is load-bearing: `#openPayload`
      // makes the same check before any work runs, so a keyless daemon fails
      // there — having spent nothing — rather than here, having spent a whole
      // job and lost the answer. Anything that moves the fetch after execution
      // turns this branch into wasted compute.
      throw new Error("this daemon has no keys, so it cannot seal a result");
    }
    const keys = await identity.keys();
    return seal({
      // The outcome **and how it was produced**, as one signed statement —
      // cloud_008 §2.5. Sealing only the outcome would leave the site
      // trusting the envelope for the answer and an unsigned request body for
      // everything about it.
      plaintext: JSON.stringify({ outcome, ran } satisfies SealedOutcome),
      senderKeys: keys,
      // Back to the site that sent it, which is not necessarily the only
      // site this machine serves. Sealing to `sitePinned` would send site B's
      // answer to site A — unopenable there, and readable by nobody, which
      // presents as a job that ran and never came back.
      recipientEncryptionPublic: this.#pinFor(job).encryption,
      context: {
        jobId: job.id,
        senderKeyId: keyId(publicIdentityOf(keys).identity),
        recipientKeyId: keyId(this.#pinFor(job).identity),
        // This runner's clock, not the process's — cloud_008 §31. The only
        // `Date.now()` left in this class, in the one place that stamps a
        // deadline somebody else enforces: a test that moves time moved every
        // other clock here and not this one, so a sealed result carried an
        // expiry from a different timeline than the lease it answered.
        deadlineAt: this.#now() + ENVELOPE_MAX_AGE_MS,
        direction: "result",
      },
    });
  }

  /**
   * Collect the payload, waiting if the upstream does not have it yet.
   *
   * On the direct plane this always succeeds first time: the site *is* the
   * upstream, so it seals when asked. Through a relay the two are different
   * parties — the site must be told which device claimed before it can seal to
   * it — and `not-ready` is a normal answer for as long as that takes.
   *
   * Discovered by the skeleton relay, which is the reason it exists: the
   * original claim-then-fetch had no wait here, so the first relayed job was
   * claimed, refused with a 409 the daemon treated as a rejection, and
   * abandoned while still holding a perfectly good lease.
   *
   * Bounded, and by the lease rather than by a retry count: waiting past our
   * own lease means racing whoever gets the job next. Returning `null` gives
   * the job up quietly — the upstream's `awaiting-payload` timer will requeue
   * it, and the stub was never lost.
   */
  async #fetchWhenSealed(
    job: ClaimedStub,
  ): Promise<{ envelope: SealedEnvelope } | null> {
    const deadline = Math.min(job.lease.expiresAt, this.#now() + 30_000);
    let delay = 50;
    for (;;) {
      try {
        return await this.#options.client.fetch({
          runnerId: this.#options.runnerId,
          jobId: job.id,
          leaseId: job.lease.id,
        });
      } catch (error) {
        const notReady =
          error instanceof ClientError && error.kind === "not-ready";
        if (!notReady) throw error;
        if (this.#now() + delay >= deadline) {
          this.#options.onEvent?.({
            type: "error",
            message: `gave up waiting for the payload of ${job.id}`,
          });
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Backs off, but stays responsive: a site that is merely slow should
        // not cost the whole lease, and one that is gone is not worth polling.
        delay = Math.min(delay * 2, 1_000);
      }
    }
  }

  /**
   * Open work sealed to this machine, or refuse to run it.
   *
   * A failure here is not a job failure to be reported — it is a claim that
   * the work came from the pinned site, which did not hold. Running it anyway
   * would be running whatever an intermediary supplied, on the owner's
   * hardware and their subscription.
   */
  async #openPayload(
    job: ClaimedStub,
    envelope: SealedEnvelope,
  ): Promise<JobPayload> {
    const identity = this.#options.identity;
    if (!identity) {
      throw new Error(
        "this daemon has no keys, so it cannot open work sealed to it",
      );
    }
    const keys = await identity.keys();

    // Which site's key opens this, decided by the stub — Amendment A §A.3
    // makes `stub.site` a key id precisely so this is a lookup the daemon can
    // do without asking anybody.
    const pinned = this.#pinFor(job);
    const pinnedKeyId = keyId(pinned.identity);

    // What the envelope *claims* about its sender, checked against what the
    // stub *says* about its site, before any crypto — cloud_009 §4.2.
    //
    // The relay hands over both, and it is the party that would benefit from
    // them disagreeing: a stub naming a site this machine trusts, wrapped
    // around a payload from somewhere else. `open` below refuses that too,
    // because the signature will not verify against the pinned key — which is
    // exactly why this check has to exist separately and say something
    // different. A refusal that reads "the payload did not verify" sends
    // whoever is debugging it to the crypto, and the fault is in the routing.
    //
    // Neither value is trusted: `senderKeyId` is inside the signature, so a
    // relay that edits it to match only moves the failure back to `open`.
    if (envelope.senderKeyId !== job.site) {
      throw new Error(
        `refusing job ${job.id}: the stub names site ${job.site}, but the ` +
          `payload declares it was sealed by ${envelope.senderKeyId}`,
      );
    }

    const opened = await open({
      envelope,
      recipientKeys: keys,
      senderIdentityPublic: pinned.identity,
      expected: {
        jobId: job.id,
        senderKeyId: pinnedKeyId,
        recipientKeyId: keyId(publicIdentityOf(keys).identity),
        direction: "payload",
      },
    });
    if (!opened.ok) {
      throw new Error(
        `refusing job ${job.id}: its payload did not verify as coming from ` +
          `the app this device paired with (${opened.reason})`,
      );
    }
    return JSON.parse(opened.plaintext) as JobPayload;
  }

  /**
   * The pinned key for the site a stub names — cloud_009 §5.
   *
   * One place, because both legs need it and they must agree: opening the
   * payload with site A's key while sealing the answer to site B is a job
   * that runs, produces something nobody can read, and reports success.
   *
   * A site the map does not hold is refused by name rather than falling back
   * to any key at hand. The fallback is the failure this exists to prevent —
   * the relay chooses `stub.site`, and a daemon that treats an unknown site
   * as "probably the one I know" has handed the choice of which key verifies
   * its work to the party the pinning is defending against.
   */
  /**
   * The sites this daemon is pinned to, as the upstream last described them.
   *
   * Seeded from the pairing and replaced by every heartbeat — cloud_009 §5.
   * Held here rather than read from options each time because it *changes*:
   * a set frozen at construction would serve a site whose consent ended
   * until the process restarted.
   */
  #sites: Map<string, PublicIdentity>;

  /** Every site ever approved here, with the key it was approved under. */
  readonly #known: Map<string, PublicIdentity>;

  /**
   * Ids whose key has been superseded, and until when this machine will still
   * serve them — byollm_009 Amendment C, `retiringUntil`.
   *
   * A rotation is not instant on the wire. Work enqueued a minute before it
   * was signed by the old key and names the old id, and a daemon that dropped
   * that pin the moment the projection moved would refuse jobs that are
   * perfectly good — a flag day, for everyone whose heartbeat happened to
   * arrive on the wrong side of the change.
   *
   * **This machine's clock decides**, not the projection's deadline alone.
   * The upstream proposes a moment; a value in the past is already over and a
   * value beyond the protocol's window is clamped to it. A projection that
   * could extend this at will would be a two-key site forever, decided by the
   * party the design does not trust.
   */
  readonly #retiring = new Map<string, number>();

  /** Offered, never approved: shown to the user, served to nobody. */
  readonly #pending = new Map<string, PublicIdentity>();

  /**
   * Pending ids already reported, so a five-second heartbeat does not repeat
   * itself — the same rule `awaitingConsent` follows.
   */
  readonly #announced = new Set<string>();

  /**
   * Take a roster the upstream delivered — Amendment G.
   *
   * Verified against the key pinned at pairing, and **held only if it
   * verifies**. A refused roster leaves the previous one in place rather than
   * clearing it: a relay that could replace a good roster with a broken one
   * would otherwise narrow this device on demand, which is the denial this
   * design accepts turned into something sharper.
   *
   * A device with no pinned control-plane key holds no roster at all. There is
   * nothing to check a signature against, and accepting one on that basis
   * would be trusting whoever delivered it — the exact substitution pinning
   * exists to refuse.
   */
  /**
   * The heartbeat path, reachable from a test.
   *
   * Named for what it is rather than hidden behind a fake heartbeat: driving
   * a whole exchange to reach one branch tests the exchange, and the branch
   * is what Amendment G rests on.
   */
  applyRosterForTest(roster: SignedRoster | undefined): void {
    this.#applyRoster(roster);
  }

  #applyRoster(roster: SignedRoster | undefined): void {
    if (roster === undefined) return;
    const key = this.#options.controlPlanePublic;
    if (key === undefined) {
      // Evidence, not a failure: this upstream sends rosters, so it has a
      // control plane — and this pairing holds no key from it, which can only
      // mean it was made before roster sync existed. The remedy is a re-pair,
      // and this is the one refusal that has one.
      this.#noteRosterRefusal("no-pinned-key", roster);
      return;
    }
    const refusal = verifyRoster({
      roster,
      owner: this.#options.owner,
      controlPlanePublic: key,
      now: this.#now(),
    });
    if (refusal !== null) {
      this.#noteRosterRefusal(refusal, roster);
      return;
    }
    // An older document than the one already held is not an update. Without
    // this a relay could replay yesterday's membership over today's, inside
    // the age window, and every signature check would pass.
    if (this.#roster !== undefined && roster.issuedAt < this.#roster.issuedAt) {
      this.#noteRosterRefusal("stale", roster);
      return;
    }
    this.#roster = roster;
    this.#rosterRefusal = undefined;
  }

  #noteRosterRefusal(refusal: RosterRefusal, roster: SignedRoster): void {
    if (this.#rosterRefusal === refusal) return;
    this.#rosterRefusal = refusal;
    this.#options.onEvent?.({
      type: "roster-refused",
      refusal,
      issuedAt: roster.issuedAt,
    });
  }

  /**
   * Who this device's roster admits, right now.
   *
   * `undefined` when there is no usable roster — which is a different answer
   * from "admits nobody", and the caller has to say which it means. A stale
   * roster is not consulted at all: staleness is revocation latency, and a
   * membership this device can no longer confirm is not one it may act on.
   */
  rosterMembers(): readonly string[] | undefined {
    const roster = this.#roster;
    if (roster === undefined) return undefined;
    return this.#now() - roster.issuedAt > ROSTER_MAX_AGE_MS
      ? undefined
      : roster.members;
  }

  /** Why the last roster was refused, for the file. */
  rosterRefusal(): RosterRefusal | undefined {
    return this.#rosterRefusal;
  }

  /** The roster as it arrived, for the file. Verified, or absent. */
  heldRoster(): SignedRoster | undefined {
    return this.#roster;
  }

  /** What `byollm status` says about the roster. */
  rosterStatus(): {
    readonly held: boolean;
    readonly members: number;
    readonly stale: boolean;
    readonly issuedAt?: number;
    readonly refusal?: RosterRefusal;
  } {
    const roster = this.#roster;
    if (roster === undefined) {
      return {
        held: false,
        members: 0,
        stale: false,
        ...(this.#rosterRefusal === undefined
          ? {}
          : { refusal: this.#rosterRefusal }),
      };
    }
    return {
      held: true,
      members: roster.members.length,
      stale: this.#now() - roster.issuedAt > ROSTER_MAX_AGE_MS,
      issuedAt: roster.issuedAt,
      ...(this.#rosterRefusal === undefined
        ? {}
        : { refusal: this.#rosterRefusal }),
    };
  }

  /**
   * Take the upstream's site set, refusing a key that moved under an id.
   *
   * Adds and removals are ordinary: consent is a thing users change, and a
   * site leaving the set is revoked for that site alone. A **changed key for
   * an id already pinned** is not ordinary — the map is keyed by identity key
   * id, so a new identity is a new entry, and this is the encryption key
   * moving under an identity whose fingerprint somebody already compared.
   * Pinning exists to refuse exactly that, so it is kept and reported rather
   * than replaced. Amendment A.3.1's rotation is an explicit path.
   */
  #applySites(
    sites: Record<string, PublicIdentity>,
    successions:
      | Record<
          string,
          { succeeds: Succession[]; retiringUntil?: number | undefined }
        >
      | undefined,
  ): void {
    for (const [id, site] of Object.entries(sites)) {
      // The upstream's account of a site, checked before anything is pinned.
      // A key that is not signed by the identity presenting it is what
      // `connect` refuses at pairing (`connect.ts`), and the heartbeat is the
      // same claim arriving later — an upstream that could add a site here
      // without this check would have a door around the ceremony.
      if (!verifyPublicIdentity(site)) {
        this.#refuseSite(
          id,
          "its encryption key is not signed by the identity presenting it",
        );
        continue;
      }
      // The map key is the site's identity key id (Amendment A §A.3) and
      // `stub.site` names the same id. If the key and the identity disagree,
      // a stub could name an id whose pin belongs to a different identity —
      // the pin lookup would succeed while pointing at the wrong site.
      if (keyId(site.identity) !== id) {
        this.#refuseSite(id, "the id it is filed under is not its key id");
        continue;
      }

      const approved = this.#known.get(id);
      if (approved === undefined && this.#rotateInto(id, site, successions)) {
        // A verified succession. Handled above rather than here because it is
        // not a stranger and not a substitution: it is a key this machine
        // already vouched for, signing for the one in front of it.
        continue;
      }
      if (approved === undefined) {
        // Never approved on this machine. **Not pinned, and nothing runs for
        // it** — this is the fence V1-1 found missing. Consent to serve a
        // site lives on the site's side of the relay, where the relay itself
        // could write it; the machine that will do the work says yes here.
        const offered = this.#pending.get(id);
        if (!offered || !sameKey(offered, site)) {
          this.#pending.set(id, site);
          this.#announced.delete(id);
        }
        if (!this.#announced.has(id)) {
          this.#announced.add(id);
          this.#options.onEvent?.({
            type: "site-awaiting-approval",
            site: id,
            fingerprint: fingerprint(site.identity),
          });
        }
        continue;
      }

      if (!sameKey(approved, site)) {
        // A key that moved under an id somebody already compared a
        // fingerprint of. Refused whether the id is currently served or was
        // dropped and re-offered: `#known` outlives consent precisely so
        // remove-then-re-add is not a way around this branch.
        this.#options.onEvent?.({ type: "site-key-changed", site: id });
        continue;
      }

      // Pinned from `#known` rather than from the heartbeat: the bytes this
      // machine seals to come off its own disk, having been approved once,
      // rather than off the wire every few seconds.
      this.#sites.set(id, approved);
    }

    for (const id of [...this.#sites.keys()]) {
      if (id in sites) continue;
      // Superseded rather than withdrawn: keep serving it until this machine's
      // own clock says the window is over. Checked here rather than at pin
      // time so that a site which withdraws consent *and* rotates still has
      // its work stopped — `sites` not containing the id is the only signal
      // for consent, and the window only holds the pin open, never the route.
      const until = this.#retiring.get(id);
      if (until !== undefined && Date.now() < until) continue;
      this.#retiring.delete(id);
      this.#sites.delete(id);
      // And stop the work already running for it — V1-7.
      //
      // Consent ending used to shrink the set and nothing else: a job
      // in flight ran to completion on somebody's machine, spending their
      // electricity or their API credit, and then failed at the seal because
      // the pin it needed had just been dropped. Full cost, no result, and
      // the one person who paid for it was the one who withdrew.
      for (const [leaseId, held] of this.#active) {
        if (held.site !== id) continue;
        this.#abandoned.add(leaseId);
        held.controller.abort();
        this.#options.onEvent?.({
          type: "refused",
          jobId: held.jobId,
          reason: `site ${id} withdrew consent while this job was running`,
        });
      }
    }
    // A pending site the upstream stopped offering is no longer a question
    // waiting for an answer. It stays out of `#known`, so if it comes back it
    // is asked again rather than assumed.
    for (const id of [...this.#pending.keys()]) {
      if (id in sites) continue;
      this.#pending.delete(id);
      this.#announced.delete(id);
    }
  }

  /**
   * Refuse an offer without touching what was approved.
   *
   * Deliberately *not* a removal. A site that is being served was approved
   * here, key and all; an upstream that starts sending a malformed record for
   * it has said nothing about consent, and treating garbage as revocation
   * would hand any upstream a way to unpin a site by sending nonsense. The
   * only thing that stops a site being served is its absence from the set,
   * which is the signal consent actually speaks through.
   */
  /**
   * Accept a site whose current key proves descent from one already approved.
   *
   * byollm_009 Amendment C, and the reason `SITES_LOCALLY_APPROVED` was
   * amended rather than exempted: **a verified succession is not a changed
   * key.** The refusal that rule exists for is a new key arriving with nothing
   * but the upstream's word for it. A key that arrives with a signature by the
   * key already pinned is the same site proving continuity, and accepting it
   * is the pin doing its job rather than being bypassed.
   *
   * Mechanically the two are far apart, which is what makes this safe to
   * write: a substitution presents different bytes *for the same key id* and
   * is refused a few lines below; a succession presents a *new key id* plus a
   * signature by the old one over a statement naming both.
   *
   * ## What the chain is walked against
   *
   * `#known`, which outlives consent — every site ever approved here,
   * including ids that were dropped. That is deliberate: a site that left the
   * allowlist and came back is still one this machine vouched for, and
   * rotation must not become a way to launder that distinction in either
   * direction.
   *
   * ## Where the succession is allowed to come from
   *
   * The projection, and nowhere else. Ruling 3 makes the control plane a
   * second authority precisely so that a stolen identity key is not by itself
   * enough to move a site: the proof must be one the control plane is also
   * publishing, which means somebody got at the dashboard as well. A
   * succession arriving on a stub, a request, or any other path a site
   * controls alone would give that second authority away, so there is exactly
   * one caller of this and it is the heartbeat.
   *
   * Returns whether the id was adopted. `false` means "not a succession" —
   * the caller carries on to the stranger path, which is the right answer for
   * a chain that verifies but reaches nobody this machine knows.
   */
  #rotateInto(
    id: string,
    site: PublicIdentity,
    successions:
      | Record<
          string,
          { succeeds: Succession[]; retiringUntil?: number | undefined }
        >
      | undefined,
  ): boolean {
    const offered = successions?.[id];
    if (!offered || offered.succeeds.length === 0) return false;

    const walk = walkSuccession({
      current: id,
      chain: offered.succeeds,
      approved: (candidate) => this.#known.has(candidate),
    });

    if (walk.failure === "broken-link" || walk.failure === "too-long") {
      // Either a broken site or the attack, and this daemon cannot tell which
      // — so it does what it does for every unverifiable claim: keeps the pin
      // it has and says so. Loudly, because a chain that fails to verify is
      // the one event here that nobody should have to go looking for.
      this.#refuseSite(
        id,
        walk.failure === "too-long"
          ? "its succession chain is longer than this daemon will walk"
          : "a link in its succession chain is not signed by the key before it",
      );
      return true;
    }

    if (walk.from === undefined) return false;

    const previous = this.#known.get(walk.from);
    /* c8 ignore next */
    if (!previous) return false;

    // The approval moves. Both ids stay in `#known`: the old one because
    // tombstones are how `SITES_LOCALLY_APPROVED` refuses remove-then-re-add,
    // and the new one because it is now a key this machine has approved — by
    // the only ceremony that was ever available for it, which is the previous
    // key's signature.
    this.#known.set(id, site);
    this.#sites.set(id, site);
    this.#pending.delete(id);
    this.#announced.delete(id);

    // The predecessor keeps its pin for the length of the window, so work
    // already signed under it still verifies. Clamped to the protocol's
    // constant: the upstream may retire a key sooner than the window, never
    // later — ruling 2 makes the overlap a protocol fact rather than the
    // site's to choose, and "forever" is the value a site would pick.
    const ceiling = Date.now() + RETIREMENT_WINDOW_MS;
    const proposed = offered.retiringUntil ?? ceiling;
    this.#retiring.set(walk.from, Math.min(proposed, ceiling));

    // Announced once per rotation rather than every heartbeat: the id is in
    // `#known` from here on, so this branch is not reached again for it.
    this.#options.onEvent?.({
      type: "site-rotated",
      site: id,
      from: walk.from,
      fromFingerprint: fingerprint(previous.identity),
      fingerprint: fingerprint(site.identity),
      path: walk.path,
    });
    return true;
  }

  #refuseSite(id: string, reason: string): void {
    if (!this.#known.has(id)) this.#pending.delete(id);
    this.#options.onEvent?.({ type: "site-refused", site: id, reason });
  }

  #pinFor(job: ClaimedStub): PublicIdentity {
    const identity = this.#options.identity;
    if (!identity) {
      throw new Error("this daemon has no keys, so it has no site to pin");
    }
    const fromMap = this.#sites.get(job.site);
    if (fromMap) return fromMap;
    // Names what this machine *is* paired with, not only what it refused.
    // An earlier draft dropped that half — "paired with X" stops being a
    // sentence when there are several — and `loop.test.ts` caught it: an
    // operator reading this is comparing two fingerprints, and one of them
    // was missing.
    const paired = [...this.#sites.keys()].sort();
    throw new Error(
      `refusing job ${job.id}: it names site ${job.site}, which this device ` +
        `is not paired with (paired with ${paired.join(", ")})`,
    );
  }

  /**
   * Report-and-forget.
   *
   * A failed *report* must not crash the loop or re-run the job: the lease
   * will lapse and the server will offer the work again, which is exactly the
   * recovery the protocol is built around.
   */
  async #safely(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.#lastError =
        error instanceof Error ? error.message : "unknown error";
    }
  }

  /** Release everything on shutdown, so nothing waits for a lease to lapse. */
  async shutdown(reason: "shutdown" | "pause"): Promise<void> {
    this.#stopped = true;
    const leases = [...this.#active.entries()].map(([leaseId, held]) => ({
      jobId: held.jobId,
      leaseId,
    }));
    this.cancelAll();
    if (leases.length === 0) return;
    await this.#safely(() =>
      this.#options.client.release({
        runnerId: this.#options.runnerId,
        leases,
        reason,
      }),
    );
  }
}

/** Case-insensitive model match that tolerates Ollama's `:latest` suffix. */
function modelPresent(models: readonly string[], wanted: string): boolean {
  const target = wanted.toLowerCase();
  return models.some((model) => {
    const id = model.toLowerCase();
    return (
      id === target || id === `${target}:latest` || `${id}:latest` === target
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
