import { z } from "zod";
import { Audience } from "./audience.js";
import { BackendClass } from "./backends.js";
import { ChatPayload, GeneratePayload, JobKind } from "./kinds.js";

/**
 * The job lifecycle, made explicit by byollm_001 Rev 1 §D because the most
 * user-visible failure mode — "nothing is running my job" — was previously
 * unspecified.
 *
 * ```text
 * queued ──claim──▶ claimed ──start──▶ running ──▶ ok | error | canceled
 *   │                  │                   │
 *   │                  └──lease expiry─────┘
 *   │                         ▼
 *   │                      queued  (reclaimable, no loss)
 *   └──ttl elapsed──▶ expired
 * ```
 */
export const JobState = z.enum([
  "queued",
  "claimed",
  "running",
  "ok",
  "error",
  "canceled",
  "expired",
]);
export type JobState = z.infer<typeof JobState>;

/** States from which a job never moves again. */
export const TERMINAL_STATES = Object.freeze([
  "ok",
  "error",
  "canceled",
  "expired",
] as const satisfies readonly JobState[]);

/** Is this a state the job can never leave? */
export function isTerminal(state: JobState): boolean {
  return (TERMINAL_STATES as readonly JobState[]).includes(state);
}

/**
 * The legal transitions. Held as data so the store adapters and the
 * conformance kit agree on one definition rather than three implementations.
 */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> =
  Object.freeze({
    queued: ["claimed", "expired", "canceled"],
    // A claimed job returns to `queued` when its lease expires un-renewed
    // ({@link MUSTS.LEASE_RECLAIMABLE}).
    claimed: ["running", "queued", "canceled", "error"],
    running: ["ok", "error", "canceled", "queued"],
    ok: [],
    error: [],
    canceled: [],
    expired: [],
  });

/** May a job move from `from` to `to`? */
export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A lease: the right to work on a job until `expiresAt`. */
export const Lease = z.object({
  /**
   * Identifies *this* grant, not just its holder.
   *
   * A runner can hold a job, release it, and claim it again — three leases,
   * one runner id. Without an id for the grant itself, a lease-scoped request
   * names a mutable target ambiguously, and a replayed release from the first
   * grant lands on the third: the job returns to the queue while the daemon
   * is mid-execution, and the work runs twice on the owner's hardware.
   *
   * That was a live hole, found in review after signed requests shipped. The
   * signature scheme's replay argument rests on endpoints being idempotent —
   * and release *is*, per lease, but not across leases, because nothing in
   * the request said which one.
   */
  id: z.string().min(1),
  /** The runner holding the lease. */
  runnerId: z.string().min(1),
  /** Epoch milliseconds after which the claim is void. */
  expiresAt: z.number().int().positive(),
});
export type Lease = z.infer<typeof Lease>;

/** Payload union as it appears on a job record. */
export const JobPayload = z.union([GeneratePayload, ChatPayload]);
export type JobPayload = z.infer<typeof JobPayload>;

/**
 * A job as the daemon receives it from `/byollm/claim`.
 *
 * Note what is absent: no model, no backend, no base URL, no flags, no path.
 * Those come from the machine owner's config only
 * ({@link MUSTS.NO_PAYLOAD_ROUTING}). The wire shape is the first place that
 * rule is enforced — there is no field to carry them.
 */
export const ClaimedJob = z
  .object({
    id: z.string().min(1),
    kind: JobKind,
    payload: JobPayload,
    audience: Audience,
    /** The app's id for the user who enqueued it. */
    owner: z.string().min(1),
    /** Runner owners the app restricted a `named` job to, if any. */
    audienceAllow: z.array(z.string().min(1)).optional(),
    lease: Lease,
  })
  .strict();
export type ClaimedJob = z.infer<typeof ClaimedJob>;

/**
 * The provenance that travels with every result to the delivery seam.
 *
 * byollm_003 Rev 1: a `named`/`public` result is attacker-controlled text.
 * The app must never render volunteer output as its own AI's answer without
 * knowing that is what it is ({@link MUSTS.RESULT_PROVENANCE}).
 */
export const ResultProvenance = z
  .object({
    /** The audience the job ran under. */
    audience: Audience,
    /** The runner that produced it. */
    runnerId: z.string().min(1),
    /** The runner owner's id in this app's namespace. */
    runnerOwner: z.string().min(1),
    /** Which backend class produced it — an HTTP call or a sandboxed spawn. */
    backendClass: BackendClass,
    /** The model the runner reports having used. */
    model: z.string().min(1),
    /**
     * False only for `self` jobs. When true the app MUST treat `text` as
     * untrusted third-party content.
     */
    untrusted: z.boolean(),
  })
  .strict();
export type ResultProvenance = z.infer<typeof ResultProvenance>;

/**
 * Build provenance for a completed job. `untrusted` is derived, never
 * supplied, so no caller can mark volunteer output as first-party.
 */
export function provenanceFor(input: {
  audience: Audience;
  runnerId: string;
  runnerOwner: string;
  backendClass: BackendClass;
  model: string;
}): ResultProvenance {
  return {
    audience: input.audience,
    runnerId: input.runnerId,
    runnerOwner: input.runnerOwner,
    backendClass: input.backendClass,
    model: input.model,
    untrusted: input.audience !== "self",
  };
}

/** Successful outcome. */
export const JobResultOk = z
  .object({
    outcome: z.literal("ok"),
    text: z.string(),
    /** Optional reference to a stored artifact; never a local path. */
    artifactUrl: z.url().optional(),
  })
  .strict();

/** Failed outcome. `code` is a stable machine string; `message` is for humans. */
export const JobResultError = z
  .object({
    outcome: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
    /** Whether the app may reasonably re-enqueue. */
    retryable: z.boolean(),
  })
  .strict();

/** Cancelled outcome, reported by the daemon after honoring a cancel. */
export const JobResultCanceled = z
  .object({
    outcome: z.literal("canceled"),
  })
  .strict();

export const JobOutcome = z.discriminatedUnion("outcome", [
  JobResultOk,
  JobResultError,
  JobResultCanceled,
]);
export type JobOutcome = z.infer<typeof JobOutcome>;

/** A completed job as delivered to the app, provenance attached. */
export const DeliveredResult = z
  .object({
    jobId: z.string().min(1),
    state: JobState,
    outcome: JobOutcome.optional(),
    provenance: ResultProvenance.optional(),
  })
  .strict();
export type DeliveredResult = z.infer<typeof DeliveredResult>;
