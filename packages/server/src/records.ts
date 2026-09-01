import type {
  PayloadFor,
  PublicIdentity,
  Audience,
  Capability,
  JobKind,
  JobOutcome,
  SealedEnvelope,
  SizeClass,
  JobState,
  Lease,
  ResultProvenance,
} from "@byollm/protocol";

/**
 * A job as the server stores it.
 *
 * Adapters map this shape onto their own storage; the field meanings are
 * normative because the conformance kit asserts behaviour that depends on
 * them (TTL clock start, dependency gating, refusal tracking).
 */
export interface JobRecord {
  readonly id: string;
  readonly kind: JobKind;
  /**
   * The work, sealed to this site's own encryption key (byollm_009 §10).
   *
   * The store never holds plaintext. The app sees plaintext at enqueue and at
   * result because the app *is* the endpoint; everything in between —
   * database, backups, log aggregators, a support engineer with read access —
   * sees ciphertext.
   *
   * This is not protection from the application the user deliberately sent
   * their work to. It is protection from everything the application's storage
   * touches, which is a longer list than most people picture.
   */
  readonly envelope: SealedEnvelope;
  /** Fixed at enqueue, where the plaintext is. */
  readonly sizeClass: SizeClass;
  readonly audience: Audience;
  /**
   * The service the site named, if it named one — byollm_016 Phase B.
   *
   * Stored rather than derived, because the stub carries it to the router and
   * the router matches on it. `undefined` means the owner's default answers,
   * which is every job written before this field existed.
   */
  readonly purpose: string | undefined;
  /** The app's id for the user who enqueued it. */
  readonly owner: string;
  /** Server-side restriction on which runner owners may take a `named` job. */
  readonly audienceAllow: readonly string[] | undefined;
  /** Job ids that must all be `ok` before this becomes claimable. */
  readonly dependsOn: readonly string[];
  readonly state: JobState;
  readonly lease: Lease | null;
  /**
   * The grant that recorded this job's result — cloud_008 §3.6.
   *
   * Kept after `lease` is nulled, because "who finished this" outlives "who
   * holds this" and the two are asked for different reasons. It is what lets
   * a replay from the device that finished the job be answered *as a
   * duplicate* rather than as a stale lease — and lets a replay from any
   * other device be refused exactly as it would be for a job that is not
   * terminal, so a job id is not a terminality probe.
   */
  readonly completedByLeaseId: string | null;
  readonly createdAt: number;
  /**
   * When the job became claimable — enqueue time for a job with no
   * dependencies, or the moment its last dependency reached `ok`.
   *
   * **The TTL clock starts here, not at `createdAt`.** Starting it at enqueue
   * would expire a dependent job for the crime of waiting on a slow
   * dependency (byollm_001 Rev 1 §D, TTL clock resolved in build review).
   * `null` means still blocked.
   */
  readonly claimableAt: number | null;
  /** How long an unclaimed job may wait once claimable. */
  readonly ttlMs: number;
  /** Optional absolute deadline, independent of the TTL. */
  readonly deadlineAt: number | null;
  /**
   * Runners that released this job with reason `refused` — their local
   * allowlist declined it. Never offered to them again
   * ({@link MUSTS.REFUSAL_NOT_REOFFERED}).
   */
  readonly refusedBy: readonly string[];
  /** How many times this job has been claimed, including lease-expiry retries. */
  readonly attempts: number;
  readonly outcome: JobOutcome | null;
  readonly provenance: ResultProvenance | null;
  readonly updatedAt: number;
}

/** A paired daemon as the server stores it. */
export interface RunnerRecord {
  readonly id: string;
  /** The app's id for the user this runner is bound to — exactly one. */
  readonly owner: string;
  readonly label: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly daemonVersion: string;
  readonly capabilities: readonly Capability[];
  readonly paused: boolean;
  /** Set once; a revoked runner never un-revokes. */
  readonly revokedAt: number | null;
  readonly lastHeartbeatAt: number;
  readonly createdAt: number;
  /**
   * The device's pinned public keys. What later signatures verify against —
   * a runner id names a machine, this proves it.
   */
  readonly device: PublicIdentity;
}

/** An in-flight device-code pairing. */
export interface PairingRecord {
  /** SHA-256 of the device code. The code itself is never stored. */
  readonly deviceCodeHash: string;
  /** The short code the user reads. Unique among live pairings. */
  readonly userCode: string;
  readonly state: "pending" | "approved" | "denied";
  /** Set when approved — learned from the approving user's own session. */
  readonly owner: string | null;
  readonly runnerId: string | null;
  /**
   * Whether this approval has already been collected — cloud_008 §2.4.
   *
   * This was `runnerTokenOnce`, a bearer token held until the daemon's next
   * poll and then nulled. The token is gone (finding 37: minted, hashed,
   * written to two disks, never sent or compared), but the *deliver-once*
   * property it carried is real and separate: a replayed device code must get
   * nothing, or a code seen in a shell history is a second pairing.
   *
   * So the flag stays and the secret does not. Nulling a token to mean
   * "collected" was one field doing two jobs, and only one of them was load
   * bearing.
   */
  readonly collected: boolean;
  readonly label: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly daemonVersion: string;
  readonly capabilities: readonly Capability[];
  /**
   * The device's public keys, presented at pair start (byollm_009 §5).
   *
   * Kept on the pairing so the approving user is approving a *specific
   * machine*, not a code that any machine could later redeem. It is copied
   * onto the runner at approval.
   */
  readonly device: PublicIdentity;
  readonly expiresAt: number;
  readonly createdAt: number;
}

/**
 * What the app supplies to enqueue a job.
 *
 * Generic over the kind, so the payload has to be the payload *for* that kind.
 * These were independent — `kind: JobKind` beside `payload: JobPayload`, the
 * union of both shapes — and the pairing was left to the author's memory. A
 * chat job carrying a generate payload typechecked, built, shipped, and was
 * refused at the relay's ingress with a precise sentence nobody sees until
 * somebody clicks.
 *
 * `PayloadFor<K>` was already exported by the protocol when that happened, and
 * `enqueue` did not use it. A wrong pairing is now a compile error at the call
 * site, which is the only place that knows what it meant.
 *
 * A caller whose `kind` is a variable rather than a literal still gets the old
 * permissive union — the conditional distributes — so nothing that was legal
 * and correct stops compiling.
 */
export interface EnqueueInput<K extends JobKind = JobKind> {
  readonly kind: K;
  /** The work, in plaintext. The server seals it before it is stored. */
  readonly payload: PayloadFor<K>;
  readonly owner: string;
  /**
   * Direct lane only. Refused on the cloud lane, where it is derived.
   *
   * On the cloud lane, who may serve a job comes from the person's own
   * mapping — the service they chose, its owner, and that owner's offer scope
   * — none of which a site is told, and all of which the hub holds at claim.
   * A site declaring an audience there was a third vote cast by the one party
   * the disclosure fence forbids from knowing the answer, and its `private`
   * default silently disabled team sharing for every user who had a team.
   *
   * On the direct lane it still selects something real, which is why it stays
   * rather than going in the same release: it is the switch that turns
   * {@link EnqueueInput.audienceAllow} on. `private` is own-devices-only;
   * `team` hands the decision to the allowlist. Without it there is no way to
   * say "these runner owners, and no others", and supplier trust needs one.
   *
   * Defaults to `private` — the safe direction, and on this lane a direction
   * a caller can meaningfully choose.
   */
  readonly audience?: Audience;
  /**
   * Which of *your site's* declared purposes this job serves — Amendment L.
   *
   * **A need, never a name.** You declare purposes at registration —
   * `"revenue"`, `"writing-assistant"` — and each of your users maps them to
   * one of their own services on the consent screen. This field names the
   * purpose; the mapping does the rest.
   *
   * There is no model field, no base URL, no flags, and — since Amendment L —
   * no way to name a service either. Your vocabulary is your purposes; theirs
   * is their services; the two never meet. You learn whether a slot was
   * satisfiable and nothing else.
   *
   * Use the purpose **key**, not its label. Labels are prose for the consent
   * screen and may change; a key travels on every job and is what mappings
   * are stored against.
   *
   * Leave it out only in direct mode, which has no control plane to hold a
   * mapping and answers by kind alone.
   */
  readonly purpose?: string;
  readonly audienceAllow?: readonly string[];
  readonly dependsOn?: readonly string[];
  /** Defaults to the server config's `defaultTtlMs`. */
  readonly ttlMs?: number;
  readonly deadlineAt?: number;
  /** Caller-supplied id, for idempotent enqueue. */
  readonly id?: string;
}

/**
 * What the *store* is given — the sealed form.
 *
 * Distinct from {@link EnqueueInput} because the two are genuinely different
 * things: an app hands over work in plaintext, and what gets written down is
 * sealed. Collapsing them into one type would mean a field that is sometimes
 * readable and sometimes not, which is the kind of ambiguity that ends with
 * plaintext in a database.
 */
export interface StoredJobInput extends Omit<EnqueueInput, "payload" | "id"> {
  readonly id: string;
  readonly envelope: SealedEnvelope;
  readonly sizeClass: SizeClass;
}

/**
 * When a job's ciphertext stops being worth carrying — cloud_008 §31.
 *
 * One function because it was two expressions. The direct plane computed
 * `job.deadlineAt ?? (job.claimableAt ?? now) + job.ttlMs`; the cloud lane
 * computed `record.deadlineAt ?? record.createdAt + <a local constant>`. The
 * first branch agreed and the fallback did not, so a job with no explicit
 * deadline got two different ones depending on which lane published it — and
 * the difference is largest exactly where it matters, for a job blocked on a
 * dependency, whose `claimableAt` may be hours after `createdAt`.
 *
 * The TTL clock starts when a job becomes *claimable*, which is the rule
 * `DEPENDS_ON_GATING` and `TTL_EXPIRY` already share: a dependent job must not
 * spend its life waiting for its dependency.
 */
export function deadlineFor(
  job: Pick<JobRecord, "deadlineAt" | "claimableAt" | "ttlMs">,
  now: number,
): number {
  return job.deadlineAt ?? (job.claimableAt ?? now) + job.ttlMs;
}
