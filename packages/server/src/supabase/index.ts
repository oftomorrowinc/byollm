import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Capability,
  JobOutcome,
  JobState,
  PublicIdentity,
} from "@byollm/protocol";
import type {
  StoredJobInput,
  JobRecord,
  PairingRecord,
  RunnerRecord,
} from "../records.js";
import type {
  ApproveArgs,
  ByollmStore,
  ClaimArgs,
  AdoptArgs,
  CompleteArgs,
  CompleteResult,
  LeaseRef,
  ReleaseArgs,
  RenewArgs,
  RenewResult,
  TouchArgs,
} from "../store.js";

/**
 * `@byollm/server/supabase` — the first-party Supabase adapter.
 *
 * The piece the of-tomorrow-framework's runner module consumes verbatim.
 * Migrations ship in `supabase/migrations`; the atomic claim lives in a
 * `security definer` RPC using `FOR UPDATE SKIP LOCKED`, and the audience
 * rules are mirrored in SQL so the server refuses independently of the daemon
 * (byollm_003 §Server-side MUSTs).
 *
 * Requires the **service role** key: a runner authenticates with a bearer
 * token of its own, which is not a Supabase session, so the protocol handler
 * cannot run under RLS as the runner's user. RLS still governs everything the
 * *browser* does — the app-side policies in the migration are what protect
 * one user's jobs from another.
 *
 * @packageDocumentation
 */

/** Row shape of `byollm_jobs`. */
interface JobRow {
  id: string;
  kind: string;
  envelope: unknown;
  size_class: "small" | "medium" | "large" | "unbounded";
  audience: "private" | "team" | "public";
  owner: string;
  audience_allow: string[] | null;
  depends_on: string[];
  state: JobState;
  lease_id: string | null;
  lease_runner: string | null;
  completed_by_lease_id: string | null;
  lease_expires_at: string | null;
  claimable_at: string | null;
  ttl_ms: number;
  deadline_at: string | null;
  refused_by: string[];
  attempts: number;
  outcome: JobOutcome | null;
  provenance: JobRecord["provenance"];
  created_at: string;
  updated_at: string;
}

/** Row shape of `byollm_runners`. */
interface RunnerRow {
  id: string;
  owner: string;
  label: string;
  platform: "darwin" | "linux" | "win32";
  daemon_version: string;
  capabilities: Capability[];
  device: PublicIdentity;
  paused: boolean;
  revoked_at: string | null;
  last_heartbeat_at: string;
  created_at: string;
}

/** Row shape of `byollm_pairings`. */
interface PairingRow {
  device_code_hash: string;
  user_code: string;
  state: "pending" | "approved" | "denied";
  owner: string | null;
  runner_id: string | null;
  collected_at: string | null;
  label: string;
  platform: "darwin" | "linux" | "win32";
  daemon_version: string;
  capabilities: Capability[];
  device: PublicIdentity;
  expires_at: string;
  created_at: string;
}

const ms = (iso: string | null): number | null =>
  iso === null ? null : Date.parse(iso);

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

function toJob(row: JobRow): JobRecord {
  const leaseExpires = ms(row.lease_expires_at);
  return {
    id: row.id,
    kind: row.kind as JobRecord["kind"],
    envelope: row.envelope as JobRecord["envelope"],
    sizeClass: row.size_class,
    audience: row.audience,
    owner: row.owner,
    audienceAllow: row.audience_allow ?? undefined,
    dependsOn: row.depends_on,
    state: row.state,
    completedByLeaseId: row.completed_by_lease_id ?? null,
    lease:
      // Keyed on the lease id, not the runner. A relayed grant has no runner
      // row to point at (see AdoptArgs), and reading the lease as absent
      // because `lease_runner` is null would make an actively-held job look
      // claimable — the exact bug `adopt` exists to prevent.
      leaseExpires !== null && row.lease_id !== null
        ? {
            id: row.lease_id,
            runnerId: row.lease_runner ?? "",
            expiresAt: leaseExpires,
          }
        : null,
    createdAt: Date.parse(row.created_at),
    claimableAt: ms(row.claimable_at),
    ttlMs: row.ttl_ms,
    deadlineAt: ms(row.deadline_at),
    refusedBy: row.refused_by,
    attempts: row.attempts,
    outcome: row.outcome,
    provenance: row.provenance,
    updatedAt: Date.parse(row.updated_at),
  };
}

/**
 * A PostgREST filter matching exactly these (job, lease) pairs.
 *
 * Not two `IN` lists: `id IN (…) AND lease_id IN (…)` is a cross product, and
 * while UUID uniqueness makes a mismatch improbable, "improbable" is not the
 * property a lease check should rest on. This says what it means.
 */
const leasePairs = (leases: readonly LeaseRef[]): string =>
  leases.map((l) => `and(id.eq.${l.jobId},lease_id.eq.${l.leaseId})`).join(",");

function toRunner(row: RunnerRow): RunnerRecord {
  return {
    id: row.id,
    owner: row.owner,
    label: row.label,
    platform: row.platform,
    daemonVersion: row.daemon_version,
    capabilities: row.capabilities,
    device: row.device,
    paused: row.paused,
    revokedAt: ms(row.revoked_at),
    lastHeartbeatAt: Date.parse(row.last_heartbeat_at),
    createdAt: Date.parse(row.created_at),
  };
}

function toPairing(row: PairingRow): PairingRecord {
  return {
    deviceCodeHash: row.device_code_hash,
    userCode: row.user_code,
    state: row.state,
    owner: row.owner,
    runnerId: row.runner_id,
    // Collected when it has a timestamp. This was `runner_token_once ===
    // null` — a nulled token standing in for a fact about delivery, which is
    // one field doing two jobs (cloud_008 §2.4a).
    collected: row.collected_at !== null,
    label: row.label,
    platform: row.platform,
    daemonVersion: row.daemon_version,
    capabilities: row.capabilities,
    device: row.device,
    expiresAt: Date.parse(row.expires_at),
    createdAt: Date.parse(row.created_at),
  };
}

export interface SupabaseStoreOptions {
  /** A client built with the **service role** key. */
  readonly client: SupabaseClient;
  /** Default TTL for a job once claimable. */
  readonly defaultTtlMs?: number;
}

/** Build the Supabase-backed store. */
export function supabaseStore(options: SupabaseStoreOptions): ByollmStore {
  const db = options.client;
  const defaultTtlMs = options.defaultTtlMs ?? 15 * 60_000;

  /**
   * Narrow one PostgREST response, or throw with the Postgres message.
   *
   * `supabase-js` types rows as `any` unless the project has generated
   * database types, so the assertion has to live somewhere. Confining it to
   * these two helpers — against the row interfaces declared above — keeps
   * every call site typed and leaves exactly one place to review.
   */
  /* eslint-disable @typescript-eslint/no-unnecessary-type-parameters --
     T appears only in the return type because these helpers *are* the cast.
     That is the point: one reviewable place where PostgREST's `any` becomes
     one of the row interfaces above. */
  function unwrap<T>(result: {
    data: unknown;
    error: { message: string } | null;
  }): T {
    if (result.error) throw new Error(`supabase: ${result.error.message}`);
    if (result.data === null || result.data === undefined) {
      throw new Error("supabase: no data returned");
    }
    return result.data as T;
  }

  /** Same, but a missing row is a legitimate answer rather than an error. */
  function unwrapMaybe<T>(result: {
    data: unknown;
    error: { message: string } | null;
  }): T | null {
    if (result.error) throw new Error(`supabase: ${result.error.message}`);
    return (result.data ?? null) as T | null;
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

  return {
    // -- jobs ---------------------------------------------------------------

    async create(input: StoredJobInput, now: number): Promise<JobRecord> {
      const dependsOn = [...(input.dependsOn ?? [])];

      // A job with dependencies starts blocked; the trigger sets
      // `claimable_at` when the last one reaches `ok`, which is where its TTL
      // clock starts.
      let claimableAt: string | null = iso(now);
      if (dependsOn.length > 0) {
        const deps = unwrap<JobRow[]>(
          await db.from("byollm_jobs").select("id,state").in("id", dependsOn),
        ) as { id: string; state: JobState }[];
        const allDone =
          deps.length === dependsOn.length &&
          deps.every((dep) => dep.state === "ok");
        claimableAt = allDone ? iso(now) : null;
      }

      const row = {
        id: input.id,
        kind: input.kind,
        envelope: input.envelope,
        size_class: input.sizeClass,
        audience: input.audience ?? "private",
        owner: input.owner,
        audience_allow: input.audienceAllow ? [...input.audienceAllow] : null,
        depends_on: dependsOn,
        claimable_at: claimableAt,
        ttl_ms: input.ttlMs ?? defaultTtlMs,
        deadline_at:
          input.deadlineAt === undefined ? null : iso(input.deadlineAt),
      };

      // Idempotent by caller-supplied id, matching the reference store: an
      // app's retry must not duplicate work.
      const inserted = unwrapMaybe<JobRow>(
        await db
          .from("byollm_jobs")
          .upsert(row, { onConflict: "id", ignoreDuplicates: true })
          .select()
          .maybeSingle(),
      );

      if (inserted) return toJob(inserted);
      const existing = unwrap<JobRow>(
        await db.from("byollm_jobs").select().eq("id", input.id).single(),
      );
      return toJob(existing);
    },

    async get(jobId: string): Promise<JobRecord | null> {
      const row = unwrapMaybe<JobRow>(
        await db.from("byollm_jobs").select().eq("id", jobId).maybeSingle(),
      );
      return row === null ? null : toJob(row);
    },

    async claim(args: ClaimArgs): Promise<JobRecord[]> {
      // One RPC, one transaction, `FOR UPDATE SKIP LOCKED` inside
      // ({@link MUSTS.CLAIM_ATOMIC}).
      const rows = unwrap<JobRow[]>(
        await db.rpc("byollm_claim_jobs", {
          p_runner_id: args.runnerId,
          p_capabilities: args.capabilities,
          p_max: args.max,
          p_lease_ms: args.leaseMs,
        }),
      );
      return rows.map(toJob);
    },

    async renewLeases(args: RenewArgs): Promise<RenewResult> {
      await db.rpc("byollm_expire_due");
      if (args.leases.length === 0) return { renewed: [], lost: [] };

      const expiresAt = iso(args.now + args.leaseMs);
      const renewedRows = unwrap<JobRow[]>(
        await db
          .from("byollm_jobs")
          .update({
            state: "running",
            lease_expires_at: expiresAt,
            updated_at: iso(args.now),
          })
          .eq("lease_runner", args.runnerId)
          .or(leasePairs(args.leases))
          .in("state", ["claimed", "running"])
          .select("id"),
      );

      const renewedIds = new Set(renewedRows.map((row) => row.id));
      return {
        renewed: renewedRows.map((row) => ({
          jobId: row.id,
          expiresAt: args.now + args.leaseMs,
        })),
        // Anything the runner thinks it holds but did not renew is gone,
        // named by the grant it asked about rather than by a bare id — V1-3.
        lost: args.leases.filter((lease) => !renewedIds.has(lease.jobId)),
      };
    },

    async adopt(args: AdoptArgs): Promise<JobRecord | null> {
      // The predicates are the guard, evaluated in the database rather than
      // read-then-written here: `state in (queued, claimed)` is what makes
      // adopting a terminal or expired job impossible under concurrency.
      const rows = unwrap<JobRow[]>(
        await db
          .from("byollm_jobs")
          .update({
            state: "claimed",
            lease_id: args.leaseId,
            // Left null on purpose: `lease_runner` is a foreign key into
            // `byollm_runners`, and a relayed device has no row there. See
            // AdoptArgs — the site records the grant, not a machine it has
            // no relationship with.
            lease_runner: null,
            lease_expires_at: iso(args.expiresAt),
            updated_at: iso(args.now),
          })
          .eq("id", args.jobId)
          .in("state", ["queued", "claimed"])
          .select(),
      );
      const written = rows[0];
      return written === undefined ? null : toJob(written);
    },

    async complete(args: CompleteArgs): Promise<CompleteResult> {
      const state: JobState =
        args.outcome.outcome === "ok"
          ? "ok"
          : args.outcome.outcome === "canceled"
            ? "canceled"
            : "error";

      // The `in('state', ...)` predicate is the idempotency guard: a job that
      // already reached a terminal state matches nothing, so the first
      // outcome wins ({@link MUSTS.RESULT_IDEMPOTENT}). The `lease_runner`
      // predicate is {@link MUSTS.LEASE_HONORED}.
      // The `in('state', ...)` predicate is the idempotency guard. The
      // second predicate is LEASE_HONORED, and which column carries it
      // depends on the plane: a direct runner is named by id, a relayed
      // grant only by its lease. Built as a query rather than branched into
      // two, so there is one update statement and no chance of the two
      // drifting.
      let update = db
        .from("byollm_jobs")
        .update({
          state,
          lease_runner: null,
          lease_expires_at: null,
          // Which grant recorded it, kept after the lease is dropped — §3.6.
          completed_by_lease_id:
            args.holder.by === "lease" ? args.holder.leaseId : null,
          outcome: args.outcome,
          provenance: args.provenance,
          updated_at: iso(args.now),
        })
        .eq("id", args.jobId)
        .in("state", ["claimed", "running"]);
      update =
        args.holder.by === "runner"
          ? update.eq("lease_runner", args.holder.runnerId)
          : update.eq("lease_id", args.holder.leaseId);
      const rows = unwrap<JobRow[]>(await update.select());

      const written = rows[0];
      if (written === undefined) {
        const current = unwrapMaybe<JobRow>(
          await db
            .from("byollm_jobs")
            .select()
            .eq("id", args.jobId)
            .maybeSingle(),
        );
        const job = current === null ? null : toJob(current);
        // Terminal before holder — cloud_008 §3.6. The update above matched
        // nothing for one of two reasons, and the caller is owed the
        // difference: the device that already recorded this job hears
        // "duplicate", and anybody else hears the same refusal they would get
        // for a job that is not terminal, so a job id is not a terminality
        // probe.
        //
        // Decided on the row that is there rather than by a second predicate,
        // because the update is the atomic part and this is only a diagnosis
        // of why it matched nothing.
        const duplicate =
          job !== null &&
          job.provenance?.runnerId === args.runnerId &&
          (job.state === "ok" ||
            job.state === "error" ||
            job.state === "canceled") &&
          args.holder.by === "lease" &&
          job.completedByLeaseId !== null &&
          job.completedByLeaseId === args.holder.leaseId;
        return duplicate
          ? { accepted: false, duplicate: true, job }
          : { accepted: false, job };
      }
      return { accepted: true, job: toJob(written) };
    },

    async release(args: ReleaseArgs): Promise<string[]> {
      if (args.leases.length === 0) return [];

      const held = unwrap<{ id: string; refused_by: string[] }[]>(
        await db
          .from("byollm_jobs")
          .select("id,refused_by")
          .eq("lease_runner", args.runnerId)
          .or(leasePairs(args.leases)),
      );

      const released: string[] = [];
      for (const row of held) {
        const refusedBy =
          args.reason === "refused"
            ? [...new Set([...row.refused_by, args.runnerId])]
            : row.refused_by;

        const { error } = await db
          .from("byollm_jobs")
          .update({
            state: "queued",
            lease_id: null,
            lease_runner: null,
            lease_expires_at: null,
            // Newly available again, so the TTL clock restarts.
            claimable_at: iso(args.now),
            refused_by: refusedBy,
            updated_at: iso(args.now),
          })
          .eq("id", row.id)
          .eq("lease_runner", args.runnerId);
        if (error) throw new Error(`supabase: ${error.message}`);
        released.push(row.id);
      }
      return released;
    },

    async expireDue(_now: number): Promise<JobRecord[]> {
      // The sweep is a single idempotent SQL function; it reports a count
      // rather than rows, and the caller only needs to know it ran.
      const { error } = await db.rpc("byollm_expire_due");
      if (error) throw new Error(`supabase: ${error.message}`);
      return [];
    },

    async cancel(jobId: string, now: number): Promise<JobRecord | null> {
      const current = unwrapMaybe<JobRow>(
        await db.from("byollm_jobs").select().eq("id", jobId).maybeSingle(),
      );
      if (current === null) return null;

      if (current.state === "queued") {
        const rows = unwrap<JobRow[]>(
          await db
            .from("byollm_jobs")
            .update({ state: "canceled", updated_at: iso(now) })
            .eq("id", jobId)
            .eq("state", "queued")
            .select(),
        );
        const canceled = rows[0];
        return toJob(canceled ?? current);
      }

      if (current.state === "claimed" || current.state === "running") {
        // Held by a runner: the cancel travels on the next heartbeat and the
        // runner reports `canceled` itself.
        const { error } = await db
          .from("byollm_job_cancels")
          .upsert({ job_id: jobId, requested_at: iso(now) });
        if (error) throw new Error(`supabase: ${error.message}`);
      }
      return toJob(current);
    },

    async listClaimedBy(runnerId: string): Promise<JobRecord[]> {
      const rows = unwrap<JobRow[]>(
        await db.from("byollm_jobs").select().eq("lease_runner", runnerId),
      );
      return rows.map(toJob);
    },

    async listCancelRequests(runnerId: string): Promise<LeaseRef[]> {
      // The lease comes back with the row — V1-3. A bare job id is ambiguous
      // to a daemon serving two sites that chose the same one, and the lease
      // is already on the joined row.
      const rows = unwrap<{ job_id: string; byollm_jobs: unknown }[]>(
        await db
          .from("byollm_job_cancels")
          .select("job_id, byollm_jobs!inner(lease_runner, lease_id)")
          .eq("byollm_jobs.lease_runner", runnerId),
      ) as {
        job_id: string;
        byollm_jobs: { lease_id: string | null };
      }[];
      return rows
        .filter((row) => row.byollm_jobs.lease_id !== null)
        .map((row) => ({
          jobId: row.job_id,
          leaseId: row.byollm_jobs.lease_id ?? "",
        }));
    },

    // -- pairing and runners -------------------------------------------------

    /**
     * The push seam (byollm_009 §8.3), over Postgres Realtime.
     *
     * Native here, which is the point of requiring it of every adapter: the
     * backend that can push does, the one that cannot polls, and the
     * interface does not change again when streaming arrives.
     */
    subscribe(jobId: string, onChange: () => void): () => void {
      const channel = db
        .channel(`byollm_job_${jobId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "byollm_jobs",
            filter: `id=eq.${jobId}`,
          },
          () => {
            onChange();
          },
        )
        .subscribe();

      let live = true;
      return () => {
        if (!live) return;
        live = false;
        // `removeChannel` is async and nothing awaits an unsubscribe, so the
        // rejection is routed rather than dropped — an unhandled one here
        // would end the process (see the Realtime delivery channel).
        void db.removeChannel(channel).catch(() => undefined);
      };
    },

    async createPairing(record: PairingRecord): Promise<void> {
      const { error } = await db.from("byollm_pairings").insert({
        device_code_hash: record.deviceCodeHash,
        device: record.device,
        user_code: record.userCode,
        state: record.state,
        label: record.label,
        platform: record.platform,
        daemon_version: record.daemonVersion,
        capabilities: record.capabilities,
        expires_at: iso(record.expiresAt),
      });
      if (error) throw new Error(`supabase: ${error.message}`);
    },

    async getPairingByDeviceCodeHash(
      hash: string,
    ): Promise<PairingRecord | null> {
      const row = unwrapMaybe<PairingRow>(
        await db
          .from("byollm_pairings")
          .select()
          .eq("device_code_hash", hash)
          .maybeSingle(),
      );
      return row === null ? null : toPairing(row);
    },

    async getPairingByUserCode(
      userCode: string,
    ): Promise<PairingRecord | null> {
      const row = unwrapMaybe<PairingRow>(
        await db
          .from("byollm_pairings")
          .select()
          .eq("user_code", userCode)
          .maybeSingle(),
      );
      return row === null ? null : toPairing(row);
    },

    async approvePairing(args: ApproveArgs): Promise<RunnerRecord> {
      // Deliberately *not* the browser RPC: this path runs under the service
      // role with an `owner` the caller has already authenticated. Apps using
      // Supabase Auth in the browser should call `byollm_approve_pairing`
      // instead, which takes the owner from `auth.uid()` and cannot be told
      // who the user is.
      const pairing = unwrap<PairingRow>(
        await db
          .from("byollm_pairings")
          .select()
          .eq("user_code", args.userCode)
          .single(),
      );

      if (Date.parse(pairing.expires_at) <= args.now) {
        throw new Error("pairing code has expired");
      }
      if (pairing.state !== "pending") {
        throw new Error(`pairing is already ${pairing.state}`);
      }

      const runner = unwrap<RunnerRow>(
        await db
          .from("byollm_runners")
          .insert({
            owner: args.owner,
            label: pairing.label,
            platform: pairing.platform,
            daemon_version: pairing.daemon_version,
            capabilities: pairing.capabilities,
            // Carried from the pairing, exactly as the SQL RPC does. There
            // are two approval paths — this service-role one and
            // `byollm_approve_pairing` for browser callers — and a field
            // added to one and not the other produces a runner that is
            // correct through one door and broken through the other.
            device: pairing.device,
          })
          .select()
          .single(),
      );

      const { error } = await db
        .from("byollm_pairings")
        .update({
          state: "approved",
          owner: args.owner,
          runner_id: runner.id,
          // Marks the approval collectable — cloud_008 §2.4. The column held
          // a bearer token; it now holds a marker, and the next migration
          // renames it. Written as a constant rather than left null because
          // `collected` reads `=== null`, and a schema change and a code
          // change landing in one step is how a rollback strands rows.
          collected_at: null,
        })
        .eq("device_code_hash", pairing.device_code_hash);
      if (error) throw new Error(`supabase: ${error.message}`);

      return toRunner(runner);
    },

    async denyPairing(userCode: string, _now: number): Promise<void> {
      const { error } = await db
        .from("byollm_pairings")
        .update({ state: "denied" })
        .eq("user_code", userCode);
      if (error) throw new Error(`supabase: ${error.message}`);
    },

    async consumePairingToken(deviceCodeHash: string): Promise<void> {
      const { error } = await db
        .from("byollm_pairings")
        // The database's clock, not this process's — the same rule the
        // relay's lease stamps follow: two writers measuring one fact against
        // two clocks is how a "collected" row looks uncollected.
        .update({ collected_at: "now()" })
        .eq("device_code_hash", deviceCodeHash);
      if (error) throw new Error(`supabase: ${error.message}`);
    },

    async getRunner(runnerId: string): Promise<RunnerRecord | null> {
      const row = unwrapMaybe<RunnerRow>(
        await db
          .from("byollm_runners")
          .select()
          .eq("id", runnerId)
          .maybeSingle(),
      );
      return row === null ? null : toRunner(row);
    },

    async touchRunner(args: TouchArgs): Promise<RunnerRecord | null> {
      const row = unwrapMaybe<RunnerRow>(
        await db
          .from("byollm_runners")
          .update({
            capabilities: args.capabilities,
            daemon_version: args.daemonVersion,
            paused: args.paused,
            last_heartbeat_at: iso(args.now),
          })
          .eq("id", args.runnerId)
          .select()
          .maybeSingle(),
      );
      return row === null ? null : toRunner(row);
    },

    async revokeRunner(runnerId: string, now: number): Promise<void> {
      // `is('revoked_at', null)` keeps revocation one-way: an already-revoked
      // runner keeps its first revocation time.
      const { error } = await db
        .from("byollm_runners")
        .update({ revoked_at: iso(now) })
        .eq("id", runnerId)
        .is("revoked_at", null);
      if (error) throw new Error(`supabase: ${error.message}`);
    },

    async listRunners(owner?: string): Promise<RunnerRecord[]> {
      const query = db.from("byollm_runners").select();
      const rows = unwrap<RunnerRow[]>(
        owner === undefined ? await query : await query.eq("owner", owner),
      );
      return rows.map(toRunner);
    },
  };
}

export { supabaseRealtimeDelivery } from "./realtime.js";
