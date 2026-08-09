import {
  REFUSAL_MESSAGES,
  backendDescriptor,
  matchAudience,
  payloadTextLength,
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
  readonly ingress: IngressLog;
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
  readonly #active = new Map<string, AbortController>();
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
  admit(job: ClaimedJob): { ok: true } | { ok: false; reason: string } {
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
        account: backendDescriptor(route.backendId).account,
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
      const decision = this.#options.budgets.check(
        this.#now(),
        payloadTextLength({
          kind: job.kind,
          payload: job.payload,
        } as Parameters<typeof payloadTextLength>[0]),
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
    this.#active.set(job.id, controller);

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
    this.#active.get(jobId)?.abort();
  }

  /** Abort everything — revocation, or shutdown. */
  cancelAll(): void {
    for (const controller of this.#active.values()) controller.abort();
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
      activeJobIds: [...this.#active.keys()],
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

  async #handle(job: ClaimedJob): Promise<void> {
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
          jobIds: [job.id],
          reason: "refused",
        }),
      );
      return;
    }

    const route = this.#routeFor(job.kind);
    const outcome = await this.runJob(job);

    await this.#safely(() =>
      this.#options.client.result({
        runnerId: this.#options.runnerId,
        jobId: job.id,
        outcome,
        model: route?.model ?? "unknown",
        backendClass: route?.backendClass ?? "http",
        durationMs: 0,
      }),
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
    const jobIds = [...this.#active.keys()];
    this.cancelAll();
    if (jobIds.length === 0) return;
    await this.#safely(() =>
      this.#options.client.release({
        runnerId: this.#options.runnerId,
        jobIds,
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
