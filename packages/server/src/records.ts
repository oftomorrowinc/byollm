import type {
  PublicIdentity,
  Audience,
  Capability,
  JobKind,
  JobOutcome,
  JobPayload,
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
  readonly service: string | undefined;
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

/** What the app supplies to enqueue a job. */
export interface EnqueueInput {
  readonly kind: JobKind;
  /** The work, in plaintext. The server seals it before it is stored. */
  readonly payload: JobPayload;
  readonly owner: string;
  /** Defaults to `private` — the safe direction. */
  readonly audience?: Audience;
  /**
   * Which of the device owner's services should answer — byollm_016 Phase B.
   *
   * A **name from their menu**, never a description of what you want. There is
   * still no model field, no base URL and no flags: this names one entry in
   * that owner's own config, and what it resolves to is entirely theirs. A
   * name they do not advertise is refused rather than served by something
   * else, because substituting is how "pick from my list" becomes "ask for
   * anything and get something".
   *
   * Leave it out and the owner's default answers, which is what every job
   * written before this field did.
   *
   * You will not usually know the name. It is for the case where a person has
   * told your app which of *their* devices' services to use — a fine-tune they
   * named, say — not something an app invents.
   */
  readonly service?: string;
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
