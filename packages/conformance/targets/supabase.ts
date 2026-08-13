/**
 * Certify the Supabase adapter with the conformance kit.
 *
 * Run against a local stack:
 *
 * ```bash
 * cd packages/server && supabase start
 * pnpm --filter @byollm/server run conformance:supabase
 * ```
 *
 * "A server is byollm-compatible when the kit passes" — this script is that
 * sentence applied to the first-party adapter. It is the same kit, the same
 * checks and the same real daemon that certify the in-memory reference, so a
 * behaviour the two stores disagree about fails here rather than in someone's
 * production queue.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  certify,
  formatReport,
  type ConformanceTarget,
} from "@byollm/conformance";
// The built package, not `../src`: Node's type stripping does not rewrite the
// `.js` specifiers the source uses, and certifying the published entry points
// is closer to what a consumer actually gets.
import { ByollmApp, createFetchHandler } from "@byollm/server";
import { supabaseStore } from "@byollm/server/supabase";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "http://127.0.0.1:54421";
const SERVICE_KEY =
  process.env["SUPABASE_SERVICE_ROLE_KEY"] ??
  process.env["SUPABASE_SECRET_KEY"] ??
  "";

const ORIGIN = "https://supabase.byollm.test";
/** Short, because a real Postgres clock cannot be faked forward. */
const LEASE_MS = 2_000;
const TTL_MS = 1_500;
/**
 * Short for the same reason as the two above: with no fakeable clock, an
 * expiry check waits for real. The product default is ten minutes, which is
 * right for a human reading a code off a screen and wrong for a suite.
 */
const PAIRING_TTL_MS = 2_000;

if (SERVICE_KEY === "") {
  process.stderr.write(
    "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is required.\n" +
      "Run `supabase status` in packages/server to find it.\n",
  );
  process.exit(2);
}

// `createClient` infers a wider generic than the bare `SupabaseClient` alias;
// letting it infer avoids an assignment the linter cannot verify.
const client = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * The kit talks about owners as names ("alice"); Postgres needs uuids that
 * reference `auth.users`. This maps between them so the checks read the same
 * against both stores.
 */
const owners = new Map<string, string>();
const ownerNames = new Map<string, string>();

/**
 * Per-run email suffix.
 *
 * Users are created fresh each run rather than looked up, because
 * `auth.admin.listUsers` is unreliable on the local stack ("Database error
 * finding users") and a certification run must not depend on it. Unique
 * emails mean `createUser` always succeeds and never needs a fallback.
 */
const RUN = randomUUID().slice(0, 8);

async function ensureUser(name: string): Promise<string> {
  const existing = owners.get(name);
  if (existing !== undefined) return existing;

  const { data, error } = await client.auth.admin.createUser({
    email: `${name}+${RUN}@byollm.test`,
    email_confirm: true,
  });
  if (error)
    throw new Error(`could not create test user ${name}: ${error.message}`);

  const id = data.user.id;
  owners.set(name, id);
  ownerNames.set(id, name);
  return id;
}

const toName = (id: string): string => ownerNames.get(id) ?? id;

const store = supabaseStore({ client, defaultTtlMs: TTL_MS });
const app = new ByollmApp({ store });
const handler = createFetchHandler({
  store,
  verificationUrl: `${ORIGIN}/settings/runners`,
  leaseMs: LEASE_MS,
  pairingTtlMs: PAIRING_TTL_MS,
});

const target: ConformanceTarget = {
  name: "@byollm/server (Supabase adapter)",
  origin: ORIGIN,
  leaseMs: LEASE_MS,
  ttlMs: TTL_MS,
  // No `advanceTime`: a real Postgres clock cannot be moved, so the kit waits
  // for real. That is why the lease and TTL above are short.

  fetch: (request) => handler(request),

  enqueue: async (input) => {
    const handle = await app.enqueue({
      kind: input.kind,
      payload: input.payload,
      owner: await ensureUser(input.owner),
      ...(input.audience === undefined ? {} : { audience: input.audience }),
      ...(input.audienceAllow === undefined
        ? {}
        : {
            audienceAllow: await Promise.all(
              input.audienceAllow.map((name) => ensureUser(name)),
            ),
          }),
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
    return { id: handle.id };
  },

  approvePairing: async (userCode, owner) => {
    await app.approvePairing({ userCode, owner: await ensureUser(owner) });
  },

  revokeRunner: (runnerId) => app.revokeRunner(runnerId),

  cancelJob: async (jobId) => {
    await app.cancel(jobId);
  },

  job: async (jobId) => {
    const record = await app.job(jobId);
    if (!record) return null;
    return {
      state: record.state,
      ...(record.outcome === null
        ? {}
        : {
            outcome: {
              outcome: record.outcome.outcome,
              ...(record.outcome.outcome === "ok"
                ? { text: record.outcome.text }
                : {}),
            },
          }),
      ...(record.provenance === null
        ? {}
        : {
            provenance: {
              untrusted: record.provenance.untrusted,
              audience: record.provenance.audience,
              runnerOwner: toName(record.provenance.runnerOwner),
            },
          }),
    };
  },

  runnerAvailability: async (input) => {
    const availability = await app.runnerAvailability({
      kind: input.kind,
      owner: await ensureUser(input.owner),
      ...(input.audience === undefined ? {} : { audience: input.audience }),
    });
    return {
      available: availability.available,
      ...(availability.reason === undefined
        ? {}
        : { reason: availability.reason }),
    };
  },

  sweep: async () => {
    await app.sweep();
  },

  // Owner ids here are `auth.users` uuids, not the names the checks use.
  ownerId: (name) => ensureUser(name),

  reset: async () => {
    // Truncate rather than drop: the migration is what is under test, and
    // re-running it between checks would be testing the migration instead.
    // Each table names its own primary key — `byollm_job_cancels` is keyed by
    // `job_id`, and PostgREST requires a filter on every delete.
    const tables: readonly [string, string][] = [
      ["byollm_job_cancels", "job_id"],
      ["byollm_jobs", "id"],
      ["byollm_pairings", "device_code_hash"],
      ["byollm_runners", "id"],
    ];
    for (const [table, key] of tables) {
      const { error } = await client.from(table).delete().not(key, "is", null);
      if (error) throw new Error(`reset ${table}: ${error.message}`);
    }
  },
};

const report = await certify(target, {
  onProgress: (result) => {
    process.stdout.write(result.passed ? "." : "x");
  },
});
process.stdout.write(`\n\n${formatReport(report)}`);
process.exit(report.passed ? 0 : 1);
