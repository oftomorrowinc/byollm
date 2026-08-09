import type { Audience, JobKind, JobPayload, JobState } from "@byollm/protocol";

/**
 * What a server implementation must expose to be certified.
 *
 * Two halves, matching the two halves of `@byollm/server`: {@link fetch} is
 * the protocol surface a daemon talks to, and the rest is the app-side
 * control the kit needs to *set up* scenarios (enqueue a job, approve a
 * pairing, revoke a runner). A server that cannot do those things cannot be
 * driven into the states the MUSTs are about.
 *
 * Deliberately transport-agnostic: `fetch` may hand requests to an in-process
 * handler or to a real HTTP server. Both are certified the same way.
 */
export interface ConformanceTarget {
  /** Shown in the report. */
  readonly name: string;

  /**
   * Serve one protocol request. The kit calls this with URLs under
   * `${origin}/byollm/...`.
   */
  fetch(request: Request): Promise<Response>;

  /** Origin the daemon should believe it is talking to. */
  readonly origin: string;

  /** Enqueue a job as an app would. */
  enqueue(input: {
    kind: JobKind;
    payload: JobPayload;
    owner: string;
    audience?: Audience;
    audienceAllow?: readonly string[];
    dependsOn?: readonly string[];
    ttlMs?: number;
  }): Promise<{ id: string }>;

  /** Approve a pairing on behalf of a signed-in user. */
  approvePairing(userCode: string, owner: string): Promise<void>;

  /** Revoke a runner, as an owner would from a settings page. */
  revokeRunner(runnerId: string): Promise<void>;

  /** Ask for a job to be cancelled. */
  cancelJob(jobId: string): Promise<void>;

  /** Read a job's current state. */
  job(jobId: string): Promise<{
    state: JobState;
    outcome?: { outcome: string; text?: string } | undefined;
    provenance?:
      { untrusted: boolean; audience: string; runnerOwner: string } | undefined;
  } | null>;

  /** Whether a runner could take work of this shape right now. */
  runnerAvailability(input: {
    kind: JobKind;
    owner: string;
    audience?: Audience;
  }): Promise<{ available: boolean; reason?: string }>;

  /** Run the expiry sweep. */
  sweep(): Promise<void>;

  /**
   * Move the server's clock forward, if it can.
   *
   * Optional on purpose. An in-memory reference server can fake time and run
   * the lease and TTL checks instantly; a real Postgres cannot. When absent,
   * the kit falls back to genuinely waiting, which is why
   * {@link ConformanceTarget.leaseMs} and {@link ConformanceTarget.ttlMs}
   * should be small for a real-clock target.
   */
  advanceTime?(ms: number): Promise<void>;

  /** The lease duration this target grants. The kit waits on it. */
  readonly leaseMs: number;
  /** The default TTL this target applies. */
  readonly ttlMs: number;

  /**
   * Resolve a friendly name the checks use ("alice") to the id this server
   * actually uses for that person.
   *
   * Optional, defaulting to identity. It exists because owner ids are
   * **server-namespace-local** — protocol §1.1 — and a target backed by real
   * auth will use uuids, not names. A kit that assumed names round-tripped
   * would be assuming away the very thing the `named` allowlist is about.
   */
  ownerId?(name: string): Promise<string>;

  /** Return to a clean slate between checks. */
  reset(): Promise<void>;

  /** Release any resources. */
  close?(): Promise<void>;
}
