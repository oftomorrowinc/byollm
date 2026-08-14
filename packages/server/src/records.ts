import type {
  PublicIdentity,
  Audience,
  Capability,
  JobKind,
  JobOutcome,
  JobPayload,
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
  readonly payload: JobPayload;
  readonly audience: Audience;
  /** The app's id for the user who enqueued it. */
  readonly owner: string;
  /** Server-side restriction on which runner owners may take a `named` job. */
  readonly audienceAllow: readonly string[] | undefined;
  /** Job ids that must all be `ok` before this becomes claimable. */
  readonly dependsOn: readonly string[];
  readonly state: JobState;
  readonly lease: Lease | null;
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
  /** SHA-256 of the bearer token. The token itself is never stored. */
  readonly tokenHash: string;
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
   * The bearer token, held until the daemon's next poll collects it, then
   * cleared. Delivered exactly once.
   */
  readonly runnerTokenOnce: string | null;
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
  readonly payload: JobPayload;
  readonly owner: string;
  /** Defaults to `self` — the safe direction. */
  readonly audience?: Audience;
  readonly audienceAllow?: readonly string[];
  readonly dependsOn?: readonly string[];
  /** Defaults to the server config's `defaultTtlMs`. */
  readonly ttlMs?: number;
  readonly deadlineAt?: number;
  /** Caller-supplied id, for idempotent enqueue. */
  readonly id?: string;
}
