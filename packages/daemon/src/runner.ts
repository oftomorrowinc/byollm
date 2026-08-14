import {
  ENVELOPE_MAX_AGE_MS,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sizeClassCeiling,
  type ClaimedStub,
  type JobPayload,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
  REFUSAL_MESSAGES,
  matchAudience,
  type Capability,
  type ClaimedJob,
  type JobOutcome,
} from "@byollm/protocol";
import type { Allowlist } from "./allowlist.js";
import { createBackend, type Backend } from "./backends/index.js";
import type { Budgets } from "./budgets.js";
import { ClientError, type ProtocolClient } from "./client.js";
import { composePrompt } from "./compose.js";
import type { LoadedConfig, ResolvedRoute } from "./config.js";
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
    readonly sitePinned: PublicIdentity;
  };
  /** Heartbeat cadence before jitter. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  /** Notified on every state change, so the CLI can render progress. */
  readonly onEvent?: (event: RunnerEvent) => void;
  /** Injectable backend factory, so tests need no real model server. */
  readonly backendFactory?: (route: ResolvedRoute) => Backend;
}

export type RunnerEvent =
  | { readonly type: "heartbeat"; readonly capabilities: number }
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
  | { readonly type: "error"; readonly message: string };

const DEFAULT_HEARTBEAT_MS = 10_000;

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
   * The lease id is kept because every lease-scoped call has to name the
   * grant it means: a release that names only the job releases whatever
   * lease exists when it arrives, which for a replayed request is not the
   * one this daemon meant (byollm_009 §4.2, `Lease.id`).
   */
  readonly #active = new Map<
    string,
    { controller: AbortController; leaseId: string }
  >();
  readonly #now: () => number;
  #capabilities: Capability[] = [];
  #paused = false;
  #revoked = false;
  #stopped = false;
  #lastError: string | undefined;
  #completed = 0;
  #refused = 0;

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
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
  async detectCapabilities(): Promise<Capability[]> {
    const capabilities: Capability[] = [];

    for (const route of this.#options.loaded.routes) {
      const backend = this.#backendFor(route);
      const health = await backend.health();
      if (!health.healthy) continue;

      // If the backend enumerates its models, honour that: advertising a
      // model the server does not have would be advertising a lie.
      if (
        health.models.length > 0 &&
        !modelPresent(health.models, route.model)
      ) {
        continue;
      }

      capabilities.push({
        kind: route.kind,
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
    const key = `${route.backendKey}:${route.backendId}`;
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
      route.backendKey,
      route.spendDailyCapCents,
      this.#now(),
    );
  }

  #routeFor(kind: string): ResolvedRoute | undefined {
    return this.#options.loaded.routes.find((route) => route.kind === kind);
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
    const route = this.#routeFor(job.kind);
    if (!route) {
      // An unknown or unrouted kind is refused, never guessed
      // ({@link MUSTS.KIND_TYPED_ONLY}).
      return { ok: false, reason: REFUSAL_MESSAGES["no-capability"] };
    }

    const match = matchAudience(
      {
        owner: job.owner,
        audience: job.audience,
        audienceAllow: job.audienceAllow,
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
    const route = this.#routeFor(job.kind);
    if (!route) {
      return {
        outcome: "error",
        code: "no-capability",
        message: "this machine has no route for that job kind",
        retryable: false,
      };
    }

    const controller = new AbortController();
    this.#active.set(job.id, { controller, leaseId: job.lease.id });

    const prompt = composePrompt(job);
    const community = job.owner !== this.#options.owner;
    const limits = this.#options.loaded.config;

    await this.#options.ingress.recordPrompt({
      at: this.#now(),
      origin: this.#options.client.origin,
      jobId: job.id,
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
          route.backendKey,
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
      this.#active.delete(job.id);
    }
  }

  /** Abort a job's in-flight backend call ({@link MUSTS.CANCEL_HONORED}). */
  cancelJob(jobId: string): void {
    this.#active.get(jobId)?.controller.abort();
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
        if (error instanceof ClientError && error.kind === "revoked") {
          this.#revoked = true;
          this.cancelAll();
          this.#options.onEvent?.({ type: "revoked" });
          return;
        }
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

  /** One heartbeat-and-claim cycle. Exposed so tests can step deterministically. */
  async tick(): Promise<void> {
    const capabilities = await this.detectCapabilities();

    const heartbeat = await this.#options.client.heartbeat({
      runnerId: this.#options.runnerId,
      daemonVersion: this.#options.daemonVersion,
      capabilities,
      activeLeases: [...this.#active.entries()].map(([jobId, held]) => ({
        jobId,
        leaseId: held.leaseId,
      })),
      paused: this.#paused,
    });
    this.#options.onEvent?.({
      type: "heartbeat",
      capabilities: capabilities.length,
    });

    if (heartbeat.revoked) {
      this.#revoked = true;
      this.cancelAll();
      this.#options.onEvent?.({ type: "revoked" });
      this.#stopped = true;
      return;
    }

    // A job the server says we lost must be abandoned, not finished
    // ({@link MUSTS.LEASE_HONORED}).
    for (const jobId of heartbeat.lost) this.cancelJob(jobId);
    for (const jobId of heartbeat.cancel) this.cancelJob(jobId);

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

    const route = this.#routeFor(job.kind);
    const outcome = await this.runJob({ ...job, payload });

    const envelope = await this.#sealOutcome(job, outcome);

    await this.#safely(() =>
      this.#options.client.result({
        runnerId: this.#options.runnerId,
        jobId: job.id,
        envelope,
        disposition: outcome.outcome,
        model: route?.model ?? "unknown",
        backendClass: route?.backendClass ?? "http",
        durationMs: 0,
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
      plaintext: JSON.stringify(outcome),
      senderKeys: keys,
      recipientEncryptionPublic: identity.sitePinned.encryption,
      context: {
        jobId: job.id,
        senderKeyId: keyId(publicIdentityOf(keys).identity),
        recipientKeyId: keyId(identity.sitePinned.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
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
    const opened = await open({
      envelope,
      recipientKeys: keys,
      senderIdentityPublic: identity.sitePinned.identity,
      expected: {
        jobId: job.id,
        senderKeyId: keyId(identity.sitePinned.identity),
        recipientKeyId: keyId(publicIdentityOf(keys).identity),
        direction: "payload",
      },
    });
    if (!opened.ok) {
      throw new Error(
        `refusing job ${job.id}: its payload did not verify as coming from ` +
          `the app this machine paired with (${opened.reason})`,
      );
    }
    return JSON.parse(opened.plaintext) as JobPayload;
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
    const leases = [...this.#active.entries()].map(([jobId, held]) => ({
      jobId,
      leaseId: held.leaseId,
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
