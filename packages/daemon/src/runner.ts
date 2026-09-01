import type { ServiceReport } from "./service-line.js";
import { outcomeForSite } from "./site-outcome.js";
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
  CLOCK_ATTRIBUTION_MS,
  CLOCK_SKEW_WARN_MS,
  GRANT_MAX_AGE_MS,
  RESERVED_PURPOSE,
  type GrantRefusal,
  type SignedGrant,
  verifyGrant,
} from "@byollm/protocol";
import { createBackend, type Backend } from "./backends/index.js";
import { SpentGrants } from "./spent-grants.js";
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
  /**
   * The control plane's grant-signing key, pinned at pairing — Amendment J.
   *
   * **This field decides which of two regimes the device is in**, and it is
   * the only thing that does.
   *
   * Present: a relayed route with a control plane. Every claimed job must
   * carry a grant that verifies against this key, including the owner's own —
   * a job with no grant is refused rather than admitted by default.
   *
   * Absent: direct mode. There is no control plane to author anything, so
   * there is no way for a device to learn that a stranger may use it, and
   * the owner's own work is the only work that runs (ruled 2026-08-26). A
   * `team` offer on such a device narrows to `private`, loudly, because a
   * scope that admits nobody should not print as though it admits somebody.
   */
  readonly controlPlanePublic?: string | undefined;
  /**
   * Where already-admitted grant ids live across a restart.
   *
   * Optional, and memory-only without it: that is direct mode, where there is
   * no control plane and nothing to replay, and it is what the tests that do
   * not care about persistence get.
   */
  readonly spentGrants?: SpentGrants;
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

/**
 * Every reason a device turns a grant away.
 *
 * `verifyGrant`'s own refusals, plus the ones only a device can make: a
 * document that is genuine and about something else. Named once because it
 * was spelled twice — the event union and the method that fires it — and two
 * copies of a union drift the first time one gains a member, silently, since
 * the wider one still assigns to nothing.
 */
export type GrantRefusalCause =
  | GrantRefusal
  | "replayed"
  | "absent"
  | "wrong-user"
  | "wrong-site"
  | "wrong-kind"
  | "wrong-purpose";

export type RunnerEvent =
  | { readonly type: "heartbeat"; readonly capabilities: number }
  /** A disclosure went stale; the user has something to read — finding 48. */
  | { readonly type: "awaiting-consent"; readonly sites: readonly string[] }
  | { readonly type: "consent-resumed" }
  /** A pinned site's encryption key moved under its identity — refused. */
  | { readonly type: "site-key-changed"; readonly site: string }
  /**
   * The first job from a site this machine has never served — Amendment K.
   *
   * Loud because site policy moved to the control plane, and a change made
   * in an account should still be visible at the hardware that acts on it.
   * Fired at admission rather than after the run: a notice that followed the
   * first job would be a receipt, and the first job is the one worth warning
   * about.
   */
  | {
      readonly type: "now-serving";
      readonly site: string;
      readonly fingerprint: string;
    }
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
   * A grant arrived and was not honoured — Amendment J.
   *
   * Loud, because the consequence is a job that did not run and the cause is
   * invisible from the outside: somebody whose teammate's work stopped
   * landing has no other way to learn that the document saying it could was
   * refused, or which of the checks refused it.
   */
  /**
   * This device's clock disagrees with its control plane enough to matter.
   *
   * Ahead or behind, signed as the device sees it. A warning rather than a
   * refusal: everything still works at this point, which is exactly why it is
   * worth saying — past {@link GRANT_MAX_AGE_MS} of drift the same fact
   * arrives as every relayed job failing.
   */
  | { readonly type: "clock-skew"; readonly skewMs: number }
  /** And when it comes back, so a fixed clock stops looking broken. */
  | { readonly type: "clock-recovered"; readonly skewMs: number }
  | {
      readonly type: "grant-refused";
      readonly refusal: GrantRefusalCause;
      readonly jobId: string;
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
   * The key grants are checked against — from the pairing, or adopted later.
   *
   * Mutable because a re-pair happens in another process and must reach this
   * loop without a restart; see {@link Runner.adoptControlPlaneKey}.
   */
  #controlPlanePublic: string | undefined;
  /**
   * Grant ids this device has already acted on, with when they stop mattering.
   *
   * **Replay.** A grant is a bearer document for one unit
   * of work, and one that could be presented twice would let a relay run a
   * job again after the owner's membership ended — inside the signature's own
   * window, with every check passing.
   *
   * Keyed by grant id rather than job id, which is the distinction Amendment
   * J's pushback established: a claim that times out is re-claimed and gets a
   * *fresh* grant, so binding single-use to the job would refuse the retry
   * this device asked for.
   *
   * In memory, and bounded by {@link GRANT_MAX_AGE_MS} rather than by size. A
   * restart forgets it, which is honest and not a hole: an entry can only
   * matter for as long as the grant naming it is still fresh, and a device
   * that has restarted since is past that window anyway.
   */
  /**
   * Grants already admitted — persistent when the CLI gives it a home.
   *
   * Was a bare `Map`, which emptied on every restart while the grants it was
   * guarding stayed fresh for two minutes. See {@link SpentGrants}.
   */
  readonly #spentGrants: SpentGrants;
  /** Whether the clock is currently past the warning threshold. */
  #clockWarned = false;
  #lastUpstreamError: string | undefined;
  #lastError: string | undefined;
  #completed = 0;
  #refused = 0;

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    // Memory-only unless a caller gives it a file. A device with a control
    // plane gets one from the CLI; direct mode has no grants to replay.
    this.#spentGrants = options.spentGrants ?? new SpentGrants();
    // Seeded from the pairing this loop started with; a re-pair in another
    // process reaches it later through `adoptControlPlaneKey`.
    this.#controlPlanePublic = options.controlPlanePublic;
    // Copied, not aliased: the pairing's map is what was on disk, and this
    // one is what the upstream last said. Sharing them would let a heartbeat
    // rewrite a file nobody wrote.
    this.#sites = new Map(options.identity?.sites ?? []);
    /**
     * The pins this device already holds, checked on the way in.
     *
     * Seeded from both maps because `sites` follows what the upstream is
     * currently offering and `known` holds the ids whose consent has ended —
     * together they are every id this machine has ever pinned, which is what
     * the substitution check compares against.
     *
     * **Verified, not trusted**, and that is a check this constructor did not
     * used to make. `applyApprovals` made it, because approvals arrived
     * through the pairings file and "a file is not a smaller thing to verify
     * than a heartbeat". Amendment K deleted approvals; the file is still a
     * file, and the entries still arrive from it. Deleting the caller without
     * moving its check would have quietly removed the check with it.
     *
     * A row that fails is dropped rather than repaired: an id whose key does
     * not belong to it is a pin that would make every later comparison
     * compare against the wrong thing.
     */
    this.#known = new Map(
      [
        ...(options.identity?.known ?? []),
        ...(options.identity?.sites ?? []),
      ].filter(
        ([id, site]) =>
          verifyPublicIdentity(site) && keyId(site.identity) === id,
      ),
    );
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
  /**
   * What the last probe learned about each service, for the owner's surfaces.
   *
   * Read by `byollm status`, by `byollm connect`'s report and by the daemon's
   * own output — one answer, three renderings, through `serviceLine`.
   */
  serviceStates = new Map<string, ServiceReport>();

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
    /**
     * Why each service is or is not usable, kept rather than discarded.
     *
     * The canary already knew: it ran, it failed, the route was dropped. What
     * reached the person was "0 backends are healthy", which is true of a
     * machine with no CLI installed and of a machine whose subscription token
     * expired last week, and those want opposite actions. The check was never
     * the problem; throwing away its answer was.
     */
    this.serviceStates = new Map();
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
        /**
         * What the probe learned, kept beside the remedy that fixes it.
         *
         * Learned together, from the backend instance that knows both, so a
         * surface rendering the line later does not have to work out which
         * backend a service used in order to say how to sign it in.
         */
        const remedy =
          backend.signIn === undefined ? {} : { signIn: backend.signIn };
        if (!health.healthy) {
          this.serviceStates.set(route.service, {
            state: { kind: "missing" },
            ...remedy,
          });
        } else if (options.canary !== true || backend.canary === undefined) {
          // Nothing was asked. Not a failure — see `ServiceState.unknown`.
          this.serviceStates.set(route.service, {
            state: { kind: "unknown", model: route.model },
            ...remedy,
          });
        } else {
          this.serviceStates.set(route.service, {
            state: { kind: "answers", model: route.model },
            ...remedy,
          });
        }

        if (usable && options.canary === true && backend.canary !== undefined) {
          const proof = await backend.canary(route.model);
          if (!proof.healthy) {
            this.serviceStates.set(route.service, {
              state: {
                kind: "signed-out",
                ...(proof.detail === undefined ? {} : { detail: proof.detail }),
              },
              ...remedy,
            });
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
   * Who this device will serve, and on whose authority — Amendment G, B2.
   *
   * Two regimes, and never both at once. The one that applies is decided by
   * whether this pairing pinned a control-plane key, which is the honest
   * question: a key means this upstream has a control plane that authors
   * grants, and a device that pinned one knows whose word to check them
   * against.
   *
   * **With a key**, the grant decides. Nothing local adds and nothing local
   * subtracts — the document is the whole answer, and this device's job is to
   * establish that it is genuine, fresh, unspent, and about work this device
   * actually offers to this person.
   *
   * **Without one**, the owner's own work is the only work that runs. Direct
   * mode has no control plane, so there is no signature that could tell this
   * device a stranger may use it, and a local list of names would be back to
   * believing the site's per-job claim about who its users are — the thing
   * Amendment G property 1 outlawed, wearing an allowlist costume. Ruled
   * 2026-08-26: direct mode is owner-only.
   *
   * The two never combine, and there is no third.
   */
  #grantAdmits(job: ClaimedStub): { ok: true } | { ok: false; reason: string } {
    const key = this.#controlPlanePublic;
    if (key === undefined) {
      // Direct mode. `matchAudience` still runs and still refuses a stranger
      // at `private` scope; this only has to make sure a `team` offer does
      // not admit one, since there is nothing here that could have checked
      // who they are.
      return job.owner === this.#options.owner
        ? { ok: true }
        : {
            ok: false,
            reason:
              "this device serves its owner only — it is not paired with a " +
              "relay, so nothing here can tell it who anybody else is " +
              "(`byollm connect <relay>` to share it)",
          };
    }

    const grant = job.grant;
    if (grant === undefined) {
      // **Refused, not admitted by default.** An upstream with a control
      // plane authors a grant for every job it routes, including the owner's
      // own, so a claimed job without one is either a relay that dropped it
      // or a version skew — and both are answered the same way, because a
      // device cannot tell them apart and must not guess in the open
      // direction.
      this.#noteGrantRefusal("absent", job.id);
      return {
        ok: false,
        reason:
          `no grant arrived with job ${job.id}, and this device only runs ` +
          "relayed work its control plane has signed for",
      };
    }

    // The signature first, plus everything the signature is
    // *about* — that this grant names this device's owner, this job, and a
    // moment close enough to now to still mean something.
    const refusal = verifyGrant({
      grant,
      owner: this.#options.owner,
      jobId: job.id,
      controlPlanePublic: key,
      now: this.#now(),
    });
    if (refusal !== null) {
      this.#noteGrantRefusal(refusal, job.id);
      return { ok: false, reason: this.#grantRefusalText(refusal, grant) };
    }

    /**
     * Still check one: the grant must be about this job's *person*.
     *
     * `verifyGrant` binds the document to this device's owner and to this job
     * id. Neither says anything about who the work belongs to, and the stub's
     * `owner` is a claim by the party that routed it. A grant written for bob
     * attached to a job stubbed as carol's would otherwise admit carol —
     * every signature valid, the wrong person served, and the budget charged
     * against a name nobody authorised.
     *
     * The grant wins because it is the signed one. They are never reconciled,
     * only refused: two answers to "whose work is this" is exactly the shape
     * that must not survive the consolidation.
     */
    if (grant.user !== job.owner) {
      this.#noteGrantRefusal("wrong-user", job.id);
      return {
        ok: false,
        reason: "the grant for this job names a different user than the job",
      };
    }

    /**
     * And about this job's *slot* — the same law, applied to the rest of it.
     *
     * `user` was the first field where the signed document and the unsigned
     * stub could disagree, and the rule ratified there is general: **the
     * signature's word is the only word, and disagreement is refusal.** It was
     * applied to one field and left off two, which is how a law becomes a
     * special case.
     *
     * `kind` and `purpose` are what the control plane *resolved against*. The
     * grant says "for this purpose, at this kind, use this service", and the
     * route is then selected with `job.kind` — a value the routing party
     * chose. A relay that keeps the job id and rewrites `kind` runs the
     * resolved service under a slot the person never mapped: a different
     * per-kind limit, a different sizeClass bucket, and a consent that was
     * never given for it.
     *
     * An absent `purpose` on the stub resolves to {@link RESERVED_PURPOSE},
     * which is exactly what the engine did before signing — so the comparison
     * is against the same value the engine used, not against a raw `undefined`
     * that would refuse every single-purpose site.
     */
    /**
     * And about this job's *site*.
     *
     * Job ids are chosen per site — a daemon serving two sites can hold two
     * different jobs called `job_1` — so a grant authored for one site's
     * `job_1` satisfied every other check against another site's. The signed
     * field that should have caught it was in the control plane's namespace,
     * which this device has no way to resolve; it now carries the key id
     * pinned at approval, so the comparison is direct.
     */
    if (grant.site !== job.site) {
      this.#noteGrantRefusal("wrong-site", job.id);
      return {
        ok: false,
        reason: "the grant for this job names a different site than the job",
      };
    }

    if (grant.kind !== job.kind) {
      this.#noteGrantRefusal("wrong-kind", job.id);
      return {
        ok: false,
        reason: "the grant for this job names a different kind than the job",
      };
    }

    if (grant.purpose !== (job.purpose ?? RESERVED_PURPOSE)) {
      this.#noteGrantRefusal("wrong-purpose", job.id);
      return {
        ok: false,
        reason: "the grant for this job names a different purpose than the job",
      };
    }

    // Replay: a grant admits one job, once.
    if (this.#spentGrants.has(grant.grantId, this.#now())) {
      this.#noteGrantRefusal("replayed", job.id);
      return {
        ok: false,
        reason:
          "this grant has already been used — a grant admits one job, once",
      };
    }

    return { ok: true };
  }

  /**
   * Say something about the clock *before* it costs anybody work.
   *
   * `serverTime` has been on every heartbeat response since the field was
   * added, with a docstring saying what it is for, and the daemon read
   * `.sites`, `.successions`, `.awaitingConsent`, `.lost` and `.cancel` and
   * never this one — the ruled proactive half of the skew warning, dead since
   * it was ruled.
   *
   * The reactive half already existed and is the wrong half on its own: a
   * refusal names the clock only once drift has passed
   * {@link GRANT_MAX_AGE_MS}, by which point every relayed job has already
   * been refused. The window between {@link CLOCK_SKEW_WARN_MS} and that is
   * precisely where a warning is worth something — the device still works,
   * and its owner can fix an ntp problem before it becomes an outage.
   *
   * Warned once per crossing rather than every beat. A daemon heartbeats
   * every few seconds and a clock stays wrong for as long as it takes
   * somebody to notice; a line per beat is how a real warning becomes noise
   * that gets filtered. The state resets when the clock comes back, so a
   * second drift warns again.
   */
  #noteClockSkew(serverTime: number): void {
    // Signed: **behind** and **ahead** are different remedies and the sign is
    // the only thing that says which. Reported as the device sees it — a
    // positive number means this machine is ahead of its control plane.
    const skew = this.#now() - serverTime;
    const past = Math.abs(skew) > CLOCK_SKEW_WARN_MS;

    if (past && !this.#clockWarned) {
      this.#clockWarned = true;
      this.#options.onEvent?.({ type: "clock-skew", skewMs: skew });
    } else if (!past && this.#clockWarned) {
      this.#clockWarned = false;
      this.#options.onEvent?.({ type: "clock-recovered", skewMs: skew });
    }
  }

  /**
   * Say why, in words that send somebody to the right place.
   *
   * The clock gets named rather than implied. A device whose clock disagrees
   * with its control plane by more than {@link GRANT_MAX_AGE_MS} refuses
   * every grant it is sent, and "this grant expired" is a true sentence that
   * would have somebody debugging the relay for an afternoon. Past
   * {@link CLOCK_ATTRIBUTION_MS} of apparent disagreement the refusal says
   * what is actually wrong; below it the clock is not the story and saying so
   * would send them to check ntp about something else.
   */
  #grantRefusalText(refusal: GrantRefusal, grant: SignedGrant): string {
    const skew = this.#now() - grant.issuedAt;
    const clockIsTheStory =
      (refusal === "expired" || refusal === "from-the-future") &&
      Math.abs(skew) > GRANT_MAX_AGE_MS + CLOCK_ATTRIBUTION_MS;
    if (clockIsTheStory) {
      return (
        `this device's clock disagrees with its control plane by about ` +
        `${String(Math.round(Math.abs(skew) / 1000))}s, so every grant it is ` +
        `sent looks ${refusal === "expired" ? "expired" : "post-dated"} — ` +
        "fix the clock, not the relay"
      );
    }
    switch (refusal) {
      case "expired":
        return "the grant for this job was signed too long ago to honour";
      case "from-the-future":
        return "the grant for this job is dated in the future";
      case "wrong-owner":
        return "the grant for this job was written for a different device owner";
      case "wrong-job":
        return "the grant that arrived was written for a different job";
      case "bad-signature":
        return (
          "the grant for this job is not signed by the control plane this " +
          "device paired with"
        );
    }
  }

  #noteGrantRefusal(refusal: GrantRefusalCause, jobId: string): void {
    this.#options.onEvent?.({ type: "grant-refused", refusal, jobId });
  }

  /**
   * Decide whether this machine will run a claimed job.
   *
   * The upstream already applied its own version of these rules, and that is
   * not what this checks. This is the device enforcing against the upstream.
   *
   * **Four checks, and they are now the whole of it** — Amendment J folded
   * consent, membership, admission and selection into one signed document, so
   * what remains on this side is the entire defence:
   *
   * 1. **the signature**, against the key pinned at pairing, over a document
   *    that must name this owner, this job and this job's user;
   * 2. **replay** — a grant admits one job, once;
   * 3. **offer-consistency** — the service the grant names is one this device
   *    actually offers, for this kind;
   * 4. **private is absolute** — a `private` service runs the owner's work
   *    and nobody else's, whatever any grant says.
   *
   * Four is deliberately load-bearing. A bug in any one of them is a bug in
   * consent, membership, admission and selection at once, which is the price
   * of the consolidation and the reason each has its own test and its own
   * mutation.
   *
   * Check 4 is structural rather than written here, and that is the strongest
   * form it can take: {@link matchAudience} only consults `admits` in its
   * `team` branch, so a `private` service refuses a stranger before any grant
   * is looked at. **No compromise of a control plane can grant somebody
   * else's job onto a private service**, because the code path that would
   * carry the grant is not reached.
   *
   * A job that fails here is released with reason `refused`, which the
   * upstream remembers so it is never offered back.
   */
  admit(job: ClaimedStub): { ok: true } | { ok: false; reason: string } {
    // Before anything else, and before a payload is fetched: is this a site
    // this machine serves? `#pinFor` asks the same question at seal time,
    // which is *after* a backend has been paid to answer a prompt from a site
    // nobody here approved. Asked here, the answer costs a release.
    if (this.#options.identity && !this.#sites.has(job.site)) {
      return {
        ok: false,
        reason:
          `this device does not serve site ${job.site} ` +
          `(serving ${[...this.#sites.keys()].sort().join(", ") || "nothing"})`,
      };
    }

    // Checks one and two.
    const granted = this.#grantAdmits(job);
    if (!granted.ok) return granted;

    /**
     * Check three, first half: whose choice of service is this?
     *
     * On a relayed route, the grant's — it carries the resolution the control
     * plane made from this person's own mapping, and there is nothing else to
     * consult. A guard used to sit here refusing a stub that named a
     * *different* service, because for one release both could speak. Amendment
     * L took the field off the stub, so the disagreement it caught is now
     * unrepresentable rather than refused, and the guard went with the field.
     *
     * `undefined` is direct mode, where there is no control plane and the
     * owner's own defaults answer under the ambiguity law as shipped.
     */
    const requested = job.grant?.service;

    // Check three, second half: do we actually offer it, for this kind? An
    // unknown or unrouted kind is refused, never guessed
    // ({@link MUSTS.KIND_TYPED_ONLY}), and a grant naming a service this
    // device does not serve is refused the same way — the control plane
    // chooses from what this device advertised, and anything else is either
    // stale or forged.
    const route = this.#routeFor(job.kind, requested);
    if (!route) {
      return { ok: false, reason: REFUSAL_MESSAGES["no-capability"] };
    }

    const match = matchAudience(
      {
        owner: job.owner,
        audience: job.audience,
        // No `audienceAllow`: it is not on the wire any more (cloud_008
        // §0.2), and this is the branch that made it look load-bearing. It
        // narrowed a decision `admits` below already owns — the site
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
        // Checks three and four, applied by the one function that owns the
        // audience law. `true` here is not a shortcut: `#grantAdmits` above
        // is what earned it, and this predicate is only *reached* for a
        // `team` service — which is what makes check 4 structural.
        admits: () => true,
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

    /**
     * The first job from a site this machine has never served — Amendment K.
     *
     * Here, on the admitted path and before {@link runJob} touches a backend,
     * because the mitigation for "site policy moved to the account" is that
     * the machine says so *first*. Fired after the grant verified, so it is
     * evidence rather than a guess: a site the relay merely mentioned has not
     * asked this device for anything yet.
     */
    if (!this.#served.has(job.site)) {
      this.#served.add(job.site);
      const site = this.#sites.get(job.site);
      this.#options.onEvent?.({
        type: "now-serving",
        site: job.site,
        fingerprint: site ? fingerprint(site.identity) : job.site,
      });
    }

    // Spent only now, on the way out. A grant burned by a refusal would make
    // the retry that follows fail for a second, unrelated reason — and the
    // upstream re-offers with a *fresh* grant anyway, so there is nothing to
    // protect against by burning it early.
    if (job.grant !== undefined) {
      this.#spentGrants.spend(
        job.grant.grantId,
        job.grant.issuedAt,
        this.#now(),
      );
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
          : /**
             * The class, never the text — a8137b5.
             *
             * `result.message` is the CLI's own words and stays with the
             * owner: the event above, the ingress log below, `byollm status`
             * and Your Devices. It does not travel, for two reasons.
             *
             * It quotes the owner's machine — paths, usernames, config
             * locations, account emails all live in CLI errors, and a
             * stranger's page is not where those go.
             *
             * And it names the service. "the claude CLI is not signed in"
             * tells a site which model answered, which is the one thing the
             * disclosure fence exists to prevent — arriving through the error
             * path because nobody was watching the error path. Every message
             * named its backend, so every failure leaked what every success
             * is careful to hide.
             *
             * `retryable` still travels: whether to try again is the site's
             * decision and says nothing about whose machine it was.
             */
            {
              outcome: "error",
              ...outcomeForSite(result.code),
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

    this.#noteClockSkew(heartbeat.serverTime);

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

    // The grant's resolution, carried into the opened job. A relayed job runs
    // on the service the person mapped; a direct one on the owner's default.
    const resolved = job.grant?.service;
    const route = this.#routeFor(job.kind, resolved);
    const outcome = await this.runJob({ ...job, payload, service: resolved });

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

  /**
   * Sites this device has actually run work for, so the first one is loud.
   *
   * Amendment K moved site policy to the control plane: there is no longer a
   * ceremony on this machine where somebody says yes to a site, which is a
   * real reduction in what a device owner controls and is recorded as an
   * accepted trade. **This set is the mitigation.** The first job from a site
   * this machine has never served announces itself, so a change made in an
   * account is still loud at the hardware.
   *
   * Fired at admission, before the backend is touched. A notice that arrived
   * after the first job had run would be a receipt rather than a warning, and
   * the thing worth warning about is the first one.
   *
   * Distinct from {@link #known}, which is the *pinning* record and must be
   * written the moment a key is first seen. This is about work, and the two
   * answer different questions: "which key is this site's" and "has this
   * machine ever done anything for it".
   */
  readonly #served = new Set<string>();

  /**
   * Take a control-plane key that arrived after this loop started.
   *
   * `byollm connect` is a different process: it writes a new pairing and the
   * running daemon goes on holding the one it was constructed with. Without
   * this, a re-pair looks like it worked, the file gains the key, and the
   * loop keeps refusing every roster — while overwriting the file's good
   * state with its own stale refusal. Which is exactly what happened to
   * Todd's device the first time anybody re-paired for real.
   *
   * Approvals already reach this loop through the file for the same reason.
   * This is that mechanism, for the other thing pairing produces.
   *
   * **Adopted only when there is none.** A key that could be *replaced* from
   * disk would be a downgrade path: anything that could write the file could
   * swap the authority this device checks grants against. Rotation is
   * Amendment C's ceremony, not a file edit.
   */
  adoptControlPlaneKey(key: string): void {
    if (this.#controlPlanePublic !== undefined) return;
    this.#controlPlanePublic = key;
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
        /**
         * First sighting: pinned here, and served — Amendment K.
         *
         * There used to be a queue and a ceremony at this line. A site the
         * upstream offered sat unpinned and unserved until somebody ran
         * `byollm approve`, because "consent to serve a site lives on the
         * site's side of the relay, where the relay itself could write it;
         * the machine that will do the work says yes here."
         *
         * That fence moved rather than fell. Site policy is the control
         * plane's now, and what the device kept is the part a relay still
         * cannot forge: the **pairing** ceremony, where a human compared a
         * fingerprint, plus the pinning below. This machine still refuses a
         * key that moves under an id it has already pinned, and still runs
         * nothing without a grant signed by the key it pinned at pairing.
         *
         * What it no longer does is ask. The trade is recorded plainly: a
         * compromised control plane can point this device at a site its owner
         * never chose. Spend caps and `pause` bound the damage; {@link
         * #served} makes it loud. It is the largest single reduction in
         * device-side control in this design, and it is deliberate.
         */
        this.#known.set(id, site);
        this.#sites.set(id, site);
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

    // The pin moves. Both ids stay in `#known`: the old one because
    // tombstones are how remove-then-re-add is refused, and the new one
    // because it is now a key this machine has pinned — by the only ceremony
    // available for it, which is the previous key's signature.
    this.#known.set(id, site);
    this.#sites.set(id, site);

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
