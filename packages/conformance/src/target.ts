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
    /** An absolute deadline, epoch ms, on the target's clock. */
    deadlineAt?: number;
    /** The job's id, chosen by the caller — the blob checks name it first. */
    id?: string;
  }): Promise<{ id: string }>;

  /** The site's half of images by reference — byollm_021 §2. */
  readonly blobs: BlobTarget;

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
   * would be assuming away the very thing the `team` allowlist is about.
   */
  ownerId?(name: string): Promise<string>;

  /** Return to a clean slate between checks. */
  reset(): Promise<void>;

  /** Release any resources. */
  close?(): Promise<void>;
}

/**
 * The site's half of the blob path, as the kit drives it — byollm_021 §2.
 *
 * On the direct lane the site is the upstream, so these are in-process calls
 * into the server's own SDK: what `POST /relay/blobs`, the presigned `PUT`
 * and `POST /relay/blobs/received` are on the hub. A server that cannot do
 * them cannot carry an image, and is not 0.1.5-compatible.
 */
export interface BlobTarget {
  /**
   * Enqueue an `llm.vision` job with these images, as an app does: given as
   * bytes, and stripped, padded, encrypted and uploaded by the SDK.
   */
  enqueueVision(input: {
    owner: string;
    text: string;
    images: readonly Uint8Array[];
    deadlineAt?: number;
  }): Promise<{ id: string }>;

  /** Issue an input slot of `bytes` (padded plus overhead) for a job id. */
  slot(input: { jobId: string; bytes: number }): Promise<{ blob: string }>;

  /** Store `data` under a slot, as whoever holds the slot would. */
  upload(blob: string, data: Uint8Array): Promise<void>;

  /**
   * Read a job's result as the app does. For an `llm.image` job this is
   * collection, and starts the hour its output blobs outlive it by.
   */
  collect(jobId: string): Promise<{ state: string }>;

  /**
   * An `llm.image` job's images, opened and verified, as the app gets them.
   * `received: false` downloads without telling the store it holds them.
   */
  images(
    jobId: string,
    options?: { received?: boolean },
  ): Promise<readonly { mediaType: string; bytes: Uint8Array }[]>;

  /** Every blob the store holds, as stored. What C048 reads. */
  stored(): Promise<
    readonly {
      id: string;
      jobId: string;
      direction: "in" | "out";
      data: Uint8Array | null;
      /** When the store will delete it, and when it was written — epoch ms. */
      deleteAt: number;
      createdAt: number;
    }[]
  >;

  /** Everything else the store holds about jobs, serialised, for C048 to search. */
  records(): Promise<string>;
}
