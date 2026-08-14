-- BYOLLM runner tables, RLS, and the atomic claim RPC.
--
-- Platform conventions from the of-tomorrow-framework's `the-system.md` apply:
-- RLS is the only permission system, every function ships explicit
-- REVOKE/GRANT (PostgREST exposes functions at /rest/v1/rpc/ by default), and
-- helpers are wrapped `(select ...)` for the initplan.
--
-- Tables are prefixed `byollm_*` so the app folder stays a portable unit.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type byollm_job_state as enum (
  'queued', 'claimed', 'running', 'ok', 'error', 'canceled', 'expired'
);

create type byollm_audience as enum ('self', 'named', 'public');

create type byollm_offer_scope as enum ('self', 'named', 'public');

-- ---------------------------------------------------------------------------
-- Runners
-- ---------------------------------------------------------------------------

create table byollm_runners (
  id               uuid primary key default gen_random_uuid(),
  -- Exactly one user. This column is the whole of PAIR_ONE_USER.
  owner            uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 hex of the bearer token. The token itself is never stored.
  token_hash       text not null unique,
  label            text not null,
  platform         text not null check (platform in ('darwin', 'linux', 'win32')),
  daemon_version   text not null,
  capabilities     jsonb not null default '[]'::jsonb,
  -- byollm_009 §5: the device's pinned public identity. What a later
  -- signature verifies against — a runner id names a machine, this proves it.
  device           jsonb not null,
  paused           boolean not null default false,
  -- Set once. A revoked runner never un-revokes.
  revoked_at       timestamptz,
  last_heartbeat_at timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index byollm_runners_owner_idx on byollm_runners (owner);
create index byollm_runners_live_idx
  on byollm_runners (last_heartbeat_at)
  where revoked_at is null and paused = false;

-- ---------------------------------------------------------------------------
-- Pairings (device-code flow)
-- ---------------------------------------------------------------------------

create table byollm_pairings (
  device_code_hash text primary key,
  -- Short code the user reads. Unique among live pairings.
  user_code        text not null unique,
  state            text not null default 'pending'
                     check (state in ('pending', 'approved', 'denied')),
  owner            uuid references auth.users (id) on delete cascade,
  runner_id        uuid references byollm_runners (id) on delete set null,
  -- Held until the daemon's next poll collects it, then nulled. Delivered once.
  runner_token_once text,
  label            text not null,
  platform         text not null,
  daemon_version   text not null,
  capabilities     jsonb not null default '[]'::jsonb,
  -- Presented at pair start, so the user approves a *machine* rather than a
  -- code any machine could redeem. Copied onto the runner at approval.
  device           jsonb not null,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);

create index byollm_pairings_user_code_idx on byollm_pairings (user_code);
create index byollm_pairings_expiry_idx on byollm_pairings (expires_at);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

create table byollm_jobs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null,
  -- The work, sealed to the site's own key (byollm_009 §10). The database
  -- holds ciphertext; the application opens it, because the application is
  -- the endpoint. Backups, replicas and anyone with read access see this.
  envelope       jsonb not null,
  -- Bucketed at enqueue, where the plaintext was.
  size_class     text not null default 'small'
                   check (size_class in ('small','medium','large','unbounded')),
  audience       byollm_audience not null default 'self',
  owner          uuid not null references auth.users (id) on delete cascade,
  -- Server-side restriction on which runner owners may take a `named` job.
  -- Defence in depth: the daemon's own local allowlist is the enforcing side.
  audience_allow uuid[] ,
  depends_on     uuid[] not null default '{}',
  state          byollm_job_state not null default 'queued',
  -- Identifies this *grant*, not just its holder. A runner can claim, release
  -- and re-claim the same job; without an id per grant a replayed release
  -- lands on a later lease and returns a job to the queue mid-execution.
  lease_id       uuid,
  lease_runner   uuid references byollm_runners (id) on delete set null,
  lease_expires_at timestamptz,
  -- When the job became claimable. THE TTL CLOCK STARTS HERE, not at
  -- created_at: a dependent job must not expire for waiting on a slow
  -- dependency, and a reclaimed job must not expire for time spent being
  -- actively worked on. Null means still blocked on a dependency.
  claimable_at   timestamptz,
  ttl_ms         integer not null default 900000 check (ttl_ms > 0),
  -- Absolute lifetime bound, unaffected by reclaim.
  deadline_at    timestamptz,
  -- Runners that released this job with reason 'refused'.
  refused_by     uuid[] not null default '{}',
  attempts       integer not null default 0,
  outcome        jsonb,
  provenance     jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index byollm_jobs_claimable_idx
  on byollm_jobs (claimable_at)
  where state = 'queued';
create index byollm_jobs_owner_idx on byollm_jobs (owner);
create index byollm_jobs_lease_idx
  on byollm_jobs (lease_expires_at)
  where state in ('claimed', 'running');
create index byollm_jobs_depends_idx on byollm_jobs using gin (depends_on);

-- ---------------------------------------------------------------------------
-- Cancel requests
-- ---------------------------------------------------------------------------

-- A separate table rather than a column on the job: a cancel is a *request*
-- that the holding runner has not yet acknowledged, and the job's own state
-- must keep saying `running` until the runner reports back. Folding the two
-- together would make "cancel asked for" and "cancel happened" look alike.
create table byollm_job_cancels (
  job_id       uuid primary key references byollm_jobs (id) on delete cascade,
  requested_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Dependency gating: unblock dependents when a job reaches `ok`
-- ---------------------------------------------------------------------------

create or replace function byollm_unblock_dependents()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only `ok` unblocks. A dependency that errored leaves its dependents
  -- blocked rather than releasing them into a run whose input never arrived —
  -- the chain stops where it broke.
  if new.state = 'ok' and (old.state is distinct from 'ok') then
    update byollm_jobs dependent
       set claimable_at = now(),
           updated_at   = now()
     where dependent.claimable_at is null
       and new.id = any (dependent.depends_on)
       and not exists (
         select 1
           from byollm_jobs dep
          where dep.id = any (dependent.depends_on)
            and dep.state is distinct from 'ok'
       );
  end if;
  return new;
end;
$$;

create trigger byollm_jobs_unblock_dependents
  after update of state on byollm_jobs
  for each row
  execute function byollm_unblock_dependents();

-- ---------------------------------------------------------------------------
-- Expiry sweep: leases first, then TTL. Idempotent — firing twice is safe.
-- ---------------------------------------------------------------------------

create or replace function byollm_expire_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer := 0;
  n integer;
begin
  -- 1. Reclaim lapsed leases. A job whose runner died returns to the queue
  --    with its TTL clock RESTARTED: it has not been waiting, it has been
  --    worked on, and expiring it here would throw away the recovery that
  --    lease reclaim exists to provide.
  update byollm_jobs
     set state            = 'queued',
         lease_id         = null,
         lease_runner     = null,
         lease_expires_at = null,
         claimable_at     = now(),
         updated_at       = now()
   where state in ('claimed', 'running')
     and lease_expires_at is not null
     and lease_expires_at <= now();
  get diagnostics n = row_count;
  changed := changed + n;

  -- 2. Expire what has genuinely sat unclaimed past its TTL, plus anything
  --    past its absolute deadline.
  update byollm_jobs
     set state        = 'expired',
         lease_id = null,
         lease_runner = null,
         lease_expires_at = null,
         updated_at   = now()
   where state = 'queued'
     and (
       (claimable_at is not null
         and claimable_at + (ttl_ms || ' milliseconds')::interval <= now())
       or (deadline_at is not null and deadline_at <= now())
     );
  get diagnostics n = row_count;
  changed := changed + n;

  return changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- The atomic claim (CLAIM_ATOMIC)
-- ---------------------------------------------------------------------------

create or replace function byollm_claim_jobs(
  p_runner_id   uuid,
  p_capabilities jsonb,
  p_max         integer,
  p_lease_ms    integer
)
returns setof byollm_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_revoked timestamptz;
  v_kinds text[];
begin
  select owner, revoked_at into v_owner, v_revoked
    from byollm_runners where id = p_runner_id;

  if v_owner is null then
    raise exception 'unknown runner';
  end if;
  if v_revoked is not null then
    raise exception 'runner is revoked';
  end if;

  perform byollm_expire_due();

  -- Kinds this runner is advertising *in this request*. A daemon that just
  -- lost a backend must not be handed work for it.
  select array_agg(value ->> 'kind') into v_kinds
    from jsonb_array_elements(p_capabilities);

  return query
  with candidate as (
    select j.id
      from byollm_jobs j
     where j.state = 'queued'
       and j.claimable_at is not null
       and j.claimable_at <= now()
       and j.kind = any (v_kinds)
       and not (p_runner_id = any (j.refused_by))
       -- Dependency gating, belt and braces alongside claimable_at.
       and not exists (
         select 1 from byollm_jobs dep
          where dep.id = any (j.depends_on) and dep.state is distinct from 'ok'
       )
       -- The audience rules, server side. The daemon enforces them too; this
       -- is defence in depth, and the `named` case is deliberately permissive
       -- here because the server cannot see a remote daemon's local allowlist.
       and byollm_audience_admits(j, p_runner_id, v_owner, p_capabilities)
     order by j.claimable_at
     limit p_max
     for update skip locked
  )
  update byollm_jobs j
     set state            = 'claimed',
         lease_id         = gen_random_uuid(),
         lease_runner     = p_runner_id,
         lease_expires_at = now() + (p_lease_ms || ' milliseconds')::interval,
         attempts         = j.attempts + 1,
         updated_at       = now()
    from candidate c
   where j.id = c.id
  returning j.*;
end;
$$;

-- The audience decision, mirroring `matchAudience` in @byollm/protocol.
create or replace function byollm_audience_admits(
  p_job          byollm_jobs,
  p_runner_id    uuid,
  p_runner_owner uuid,
  p_capabilities jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cap jsonb;
  v_scope text;
  v_backend text;
  v_same_owner boolean := (p_job.owner = p_runner_owner);
begin
  select value into v_cap
    from jsonb_array_elements(p_capabilities)
   where value ->> 'kind' = p_job.kind
   limit 1;

  if v_cap is null then
    return false;
  end if;

  v_scope   := v_cap ->> 'offerScope';
  v_backend := v_cap ->> 'backendId';

  -- Side 1: does the job's audience admit this runner's owner?
  if p_job.audience = 'self' and not v_same_owner then
    return false;
  end if;
  if p_job.audience = 'named'
     and not v_same_owner
     and p_job.audience_allow is not null
     and not (p_runner_owner = any (p_job.audience_allow)) then
    return false;
  end if;

  -- A daemon always runs its own owner's work.
  if v_same_owner then
    return true;
  end if;

  -- The subscription self-lock. Applied here regardless of the scope the
  -- daemon advertised: a widened scope on a subscription backend is refused,
  -- not obeyed (SUBSCRIPTION_SELF_LOCK).
  if v_backend = 'claude-cli' then
    return false;
  end if;

  -- Side 2: does the backend's offer scope admit the job's owner?
  if v_scope = 'self' then
    return false;
  end if;
  if v_scope = 'named' then
    -- The server cannot verify a remote daemon's local allowlist and must not
    -- pretend to. It offers the job; the daemon refuses if its own list says
    -- no, and the refusal is remembered in refused_by.
    return true;
  end if;
  return v_scope = 'public';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table byollm_runners     enable row level security;
alter table byollm_jobs        enable row level security;
alter table byollm_pairings    enable row level security;
alter table byollm_job_cancels enable row level security;

-- A user sees and manages their own runners, and nobody else's.
create policy byollm_runners_owner_select on byollm_runners
  for select using ((select auth.uid()) = owner);
create policy byollm_runners_owner_update on byollm_runners
  for update using ((select auth.uid()) = owner);
create policy byollm_runners_owner_delete on byollm_runners
  for delete using ((select auth.uid()) = owner);

-- A user sees their own jobs. Community jobs they volunteered to run are
-- visible through the claim RPC, which is security definer — deliberately
-- not through a broad select policy, so browsing other people's prompts is
-- not possible even for a willing volunteer.
create policy byollm_jobs_owner_select on byollm_jobs
  for select using ((select auth.uid()) = owner);
create policy byollm_jobs_owner_insert on byollm_jobs
  for insert with check ((select auth.uid()) = owner);

-- Pairings are approved through the RPC below, never written directly.
create policy byollm_pairings_owner_select on byollm_pairings
  for select using ((select auth.uid()) = owner);

-- A user may ask to cancel their own job, and see that they asked.
create policy byollm_job_cancels_owner_select on byollm_job_cancels
  for select using (
    exists (
      select 1 from byollm_jobs j
       where j.id = byollm_job_cancels.job_id
         and j.owner = (select auth.uid())
    )
  );
create policy byollm_job_cancels_owner_insert on byollm_job_cancels
  for insert with check (
    exists (
      select 1 from byollm_jobs j
       where j.id = byollm_job_cancels.job_id
         and j.owner = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Pairing approval — the one door for creating a runner
-- ---------------------------------------------------------------------------

create or replace function byollm_approve_pairing(
  p_user_code  text,
  p_token_hash text
)
returns byollm_runners
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pairing byollm_pairings;
  v_runner  byollm_runners;
  v_owner   uuid := (select auth.uid());
begin
  -- The owner comes from the caller's own session. A daemon can never assert
  -- who it is; that is the whole reason pairing is interactive.
  if v_owner is null then
    raise exception 'approving a pairing requires an authenticated user';
  end if;

  select * into v_pairing from byollm_pairings
   where user_code = p_user_code for update;

  if v_pairing is null then
    raise exception 'unknown pairing code';
  end if;
  if v_pairing.expires_at <= now() then
    raise exception 'pairing code has expired';
  end if;
  if v_pairing.state <> 'pending' then
    raise exception 'pairing is already %', v_pairing.state;
  end if;

  insert into byollm_runners (owner, token_hash, label, platform,
                              daemon_version, capabilities, device)
  values (v_owner, p_token_hash, v_pairing.label, v_pairing.platform,
          v_pairing.daemon_version, v_pairing.capabilities, v_pairing.device)
  returning * into v_runner;

  update byollm_pairings
     set state = 'approved', owner = v_owner, runner_id = v_runner.id
   where device_code_hash = v_pairing.device_code_hash;

  return v_runner;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — REVOKE from PUBLIC, GRANT deliberately (the house rule)
-- ---------------------------------------------------------------------------

-- Table privileges, granted deliberately rather than inherited.
--
-- Supabase images have historically granted blanket privileges on new public
-- tables to anon/authenticated/service_role, and relying on that is how this
-- migration passed on one CLI version and failed with "permission denied" on a
-- newer one. RLS decides *which rows*; these decide *which operations* — both
-- are required, and neither is a substitute for the other.
--
-- Revoke first, then grant. Supabase images ship `ALTER DEFAULT PRIVILEGES`
-- that hand `anon` and `authenticated` ALL privileges on every new public
-- table — verified on a fresh database, where `anon` arrived holding
-- INSERT/UPDATE/DELETE on all four of these. RLS still refuses every row, so
-- nothing was exposed, but "we grant anon nothing" is only true if we take
-- away what the image already gave. Revoking makes this file authoritative
-- instead of dependent on whichever image happens to be running.
revoke all on byollm_jobs, byollm_runners, byollm_pairings, byollm_job_cancels
  from anon, authenticated;

-- `anon` is deliberately granted nothing back: no part of this schema is
-- reachable without a session.
grant select, insert on byollm_jobs to authenticated;
grant select, update, delete on byollm_runners to authenticated;
grant select on byollm_pairings to authenticated;
grant select, insert on byollm_job_cancels to authenticated;

-- The protocol handler authenticates runners with their own bearer tokens,
-- which are not Supabase sessions, so it runs as the service role.
grant select, insert, update, delete
  on byollm_jobs, byollm_runners, byollm_pairings, byollm_job_cancels
  to service_role;

revoke all on function byollm_claim_jobs(uuid, jsonb, integer, integer) from public;
revoke all on function byollm_audience_admits(byollm_jobs, uuid, uuid, jsonb) from public;
revoke all on function byollm_expire_due() from public;
revoke all on function byollm_approve_pairing(text, text) from public;
revoke all on function byollm_unblock_dependents() from public;

-- The claim RPC is called by the protocol handler with the service role, not
-- by a browser: a runner authenticates with its bearer token, which is not a
-- Supabase session.
grant execute on function byollm_claim_jobs(uuid, jsonb, integer, integer) to service_role;
grant execute on function byollm_expire_due() to service_role;

-- Approval happens in the browser, in the user's own session.
grant execute on function byollm_approve_pairing(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime — the app's delivery channel
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table byollm_jobs;
