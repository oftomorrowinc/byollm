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
    /**
     * Which site's job — V1-3.
     *
     * The stub has always carried it; the opened job did not, so everything
     * downstream of the payload — the ingress line above all — recorded a job
     * id that belongs to a site without saying which. Two sites can choose
     * the same id, and the meter is the product.
     *
     * Optional so a caller assembling a job by hand is not forced to invent
     * one, and so this reads as what it is: a fact about where the work came
     * from, not a second copy of the routing key.
     */
    site: z.string().min(1).optional(),
    lease: Lease,
  })
  .strict();
export type ClaimedJob = z.infer<typeof ClaimedJob>;

/**
 * The provenance that travels with every result to the delivery seam.
 *
 * byollm_003 Rev 1: a `named`/`public` result is attacker-controlled text.
 * The app must never render volunteer output as its own AI's answer without
 * knowing that is what it is ({@link MUSTS.PROVENANCE_NAMES_DEVICE}).
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

/**
 * What the daemon did, sealed with the answer — cloud_008 §2.5.
 *
 * These travelled in the clear on `ResultRequest`, which meant two things at
 * once. On the direct plane the site believed unauthenticated fields beside
 * an authenticated envelope — a daemon could seal one answer and *declare* it
 * came from a different model, and only the field it did not sign would be
 * recorded. Through a relay they reached a third party that acts on none of
 * them, and `model` in particular is the kind of detail Amendment A's rule
 * keeps off the wire.
 *
 * Sealed, they are the daemon's signed statement about its own run: the site
 * opens them, nothing in between sees them, and the disposition check that
 * already compares clear-text against ciphertext extends to cover them.
 */
export const RunMetadata = z
  .object({
    /** Which model actually served it. */
    model: z.string().min(1),
    backendClass: BackendClass,
    /** Wall-clock milliseconds the backend call took. */
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type RunMetadata = z.infer<typeof RunMetadata>;

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

/**
 * The plaintext inside a result envelope.
 *
 * The outcome and how it was produced, together, because they are one
 * statement by one signer. A site that opened only the outcome would be
 * trusting the envelope for the answer and the request body for everything
 * about it.
 */
export const SealedOutcome = z
  .object({ outcome: JobOutcome, ran: RunMetadata })
  .strict();
export type SealedOutcome = z.infer<typeof SealedOutcome>;

/** A completed job as delivered to the app, provenance attached. */
export const DeliveredResult = z
  .object({
    jobId: z.string().min(1),
    state: JobState,
    outcome: JobOutcome.optional(),
    provenance: ResultProvenance.optional(),
    /**
     * Present, and always `true`, when this did not come from a runner —
     * {@link MUSTS.FALLBACK_LABELED}.
     *
     * The app's own `onNoRunner` value produced it: a hosted model, a cached
     * answer, an apology. It never travels on the wire, because nothing on
     * the wire produced it; it exists so that a result which did not come
     * from the user's own compute cannot be reported as though it did.
     *
     * A literal rather than a boolean, so `fallback: false` is not a
     * spelling anybody can reach for. The absence of this field means a
     * runner ran the job, and the *server* stamps it — an app cannot supply
     * a substitute that hides what it is.
     */
    fallback: z.literal(true).optional(),
  })
  .strict();
export type DeliveredResult = z.infer<typeof DeliveredResult>;

/**
 * How big a payload is, in buckets — byollm_009 §6.
 *
 * A relay routes without reading, and matching a job to a machine needs some
 * notion of size. Buckets rather than byte counts because the exact figure is
 * a stronger fingerprint than the routing decision requires, and because a
 * bucket survives compression and encoding changes that an exact count does
 * not.
 *
 * `unbounded` exists for streamed jobs, which have no size when they start.
 * It is reserved now rather than added later: byollm_009 §8.1 — adding a
 * field to a published envelope is the v2 break all over again.
 */
export const SizeClass = z.enum(["small", "medium", "large", "unbounded"]);
export type SizeClass = z.infer<typeof SizeClass>;

/** Where the bucket boundaries sit, in characters of payload text. */
export const SIZE_CLASS_LIMITS = Object.freeze({
  small: 4_000,
  medium: 64_000,
  large: Number.POSITIVE_INFINITY,
});

/**
 * The most a payload in this bucket can be.
 *
 * Used where a decision must be made from a stub, before the payload has been
 * fetched — a budget check, for instance. Charging the bucket's ceiling is the
 * conservative direction: it refuses slightly too eagerly rather than
 * admitting work that turns out larger than the budget allowed.
 *
 * `unbounded` returns `Infinity`, which fails every ceiling. That is correct
 * until byollm_006 defines how a streamed job is budgeted — failing closed on
 * a case nobody has designed beats inventing an allowance for it.
 */
export function sizeClassCeiling(sizeClass: SizeClass): number {
  if (sizeClass === "unbounded") return Number.POSITIVE_INFINITY;
  return SIZE_CLASS_LIMITS[sizeClass];
}

/** Bucket a payload by its text length. */
export function sizeClassOf(textChars: number): SizeClass {
  if (textChars <= SIZE_CLASS_LIMITS.small) return "small";
  if (textChars <= SIZE_CLASS_LIMITS.medium) return "medium";
  return "large";
}

/**
 * Everything an upstream may see about a job — byollm_009 §6.
 *
 * **This list is exhaustive and normative.** It is a commitment about the
 * metadata surface, not an accident of what the implementation happens to
 * send: an upstream that requires more has exceeded the protocol, and an
 * endpoint that emits more has leaked past it
 * ({@link MUSTS.STUB_METADATA_EXHAUSTIVE}).
 *
 * What is absent is the point. No payload, no model, no prompt, no result.
 * `kind` is here because capability matching happens upstream; if a later
 * revision moves matching to the daemon, `kind` moves into the ciphertext.
 */
export const JobStub = z
  .object({
    id: z.string().min(1),
    kind: JobKind,
    /** The app's id for the user who enqueued it. */
    owner: z.string().min(1),
    /**
     * Which site this job belongs to — byollm_009 Amendment A §A.3.
     *
     * **The site's identity key id**, not an id somebody assigned it. §6 has
     * listed `site` since this spec was frozen; the schema never carried it,
     * which is the drift the amendment closes.
     *
     * A key id rather than an opaque handle for one reason above the others:
     * it makes the stub *self-describing* instead of a pointer into somebody
     * else's table. A daemon holds this key id already, from pinning, so it
     * can check `stub.site` against the payload envelope's `senderKeyId`
     * without a lookup and without trusting the party that routed it. An
     * opaque id can only be believed.
     *
     * It also avoids inventing a second namespace for a thing that has a
     * canonical one — the shape of finding 41 (two owner namespaces compared
     * for equality) and of finding fourteen before it.
     *
     * Rotation is a designed transition rather than a cost: a site publishes a
     * new identity signed by the outgoing one, both are valid through an
     * overlap window, and a daemon re-keys its own map by verifying that
     * signature against the key it already pinned (§A.3.1).
     */
    site: z.string().min(1),
    audience: Audience,
    // `audienceAllow` is **not** here, and its absence is the enforcement —
    // cloud_008 §0.2.
    //
    // It was a list of the people who may run a job, travelling to every
    // routing party on every `named` job. byollm_001 Rev 1 §B settled who
    // decides that long before this schema existed: *the daemon's own list
    // decides, not the server's*, and `allowlist.predicateFor(origin)` is the
    // enforcement in both lanes. So this was a second answer to a question the
    // daemon already owned — able only to agree, in which case it was
    // redundant, or to disagree, in which case nothing said which wins.
    //
    // The rule it leaves behind, which decides the next field too: **a class
    // the router acts on may travel; membership never does.** `audience` stays
    // for exactly that reason — the relay narrows on it. A roster does not
    // travel, so `ROSTER_NOT_DISCLOSED` holds here by absence, which is the
    // strongest way for a MUST to hold.
    //
    // The site keeps its own copy on `JobRecord` and still filters candidates
    // with it before offering. That is server-internal, where the party
    // holding the list authored it.
    sizeClass: SizeClass,
    /** Reserved for byollm_006. False until streaming exists. */
    streaming: z.boolean(),
    /** Epoch ms after which the work is pointless; bounds ciphertext retention. */
    deadlineAt: z.number().int().positive(),
  })
  .strict();
export type JobStub = z.infer<typeof JobStub>;

/** A stub, plus the lease the claiming runner now holds for it. */
export const ClaimedStub = JobStub.extend({ lease: Lease }).strict();
export type ClaimedStub = z.infer<typeof ClaimedStub>;
