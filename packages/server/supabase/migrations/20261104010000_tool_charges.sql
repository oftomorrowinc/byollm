-- The site SDK's count of tool calls per job — byollm_012 §8, C040.
--
-- Three counters keep a job's tool budget, on purpose: the daemon's keeps an
-- honest device honest, the relay's keeps a modified daemon from spending the
-- site's tools on the cloud lane, and this one is the site's own. It covers
-- the direct lane, where there is no relay and `byollm_record_tool_call`
-- counts only to the protocol ceiling, and a relay that is wrong.
--
-- A table rather than a column on `byollm_tool_calls`, because on the cloud
-- lane the relay holds the calls and this database has none of them: what
-- the site knows there is only which calls it has run a handler for.
--
-- Durable, not in memory, because a serverless site runs each pump cycle in
-- a fresh process, and a counter that starts from zero every cycle refuses
-- nothing. `MemoryStore` (src/memory.ts) is the reference; this is the same
-- contract.
--
-- ## Deleted with the job
--
-- `on delete cascade` for a deleted job, and the trigger below for a job that
-- reaches a terminal state, as `byollm_tool_calls` does.

create table byollm_tool_charges (
  job_id     uuid not null references byollm_jobs (id) on delete cascade,
  call_id    text not null
               check (call_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  charged_at timestamptz not null,
  primary key (job_id, call_id)
);

-- No policies: only the service role, which bypasses RLS, reads or writes
-- it, through the function below.
alter table byollm_tool_charges enable row level security;

create or replace function byollm_tool_charges_end_with_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state in ('ok', 'error', 'canceled', 'expired') then
    delete from byollm_tool_charges where job_id = new.id;
  end if;
  return new;
end;
$$;

create trigger byollm_jobs_tool_charges_end
  after update of state on byollm_jobs
  for each row
  when (new.state is distinct from old.state)
  execute function byollm_tool_charges_end_with_job();

-- ---------------------------------------------------------------------------
-- charge: one call against its job's budget, before a handler runs
-- ---------------------------------------------------------------------------
--
-- Returns `{ "charged": n }` or `{ "refused": "budget" | "closed" }`. Locks
-- the job row, so the count and the insert are one step and two pumps
-- running at once cannot both take the last call of a budget. A call id
-- already charged answers its count again and writes nothing: a call whose
-- answer was lost may be run again, and is not counted twice.

create or replace function byollm_charge_tool_call(
  p_job_id         uuid,
  p_call_id        text,
  p_max_tool_calls integer,
  p_now            timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job  byollm_jobs;
  v_made integer;
begin
  select * into v_job from byollm_jobs where id = p_job_id for update;
  if v_job.id is null
     or v_job.state in ('ok', 'error', 'canceled', 'expired') then
    return jsonb_build_object('refused', 'closed');
  end if;

  select count(*) into v_made from byollm_tool_charges where job_id = p_job_id;

  if exists (
    select 1 from byollm_tool_charges
     where job_id = p_job_id and call_id = p_call_id
  ) then
    return jsonb_build_object('charged', v_made);
  end if;

  if v_made >= p_max_tool_calls then
    return jsonb_build_object('refused', 'budget');
  end if;

  insert into byollm_tool_charges (job_id, call_id, charged_at)
  values (p_job_id, p_call_id, p_now);
  return jsonb_build_object('charged', v_made + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- in flight: is any llm.tools job of this site still open
-- ---------------------------------------------------------------------------
--
-- `queued` counts: on the cloud lane a job a device claimed at the relay is
-- still `queued` here until a pump adopts it (byollm_012 §5.3).

create or replace function byollm_tool_jobs_in_flight()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from byollm_jobs
     where kind = 'llm.tools'
       and state in ('queued', 'claimed', 'running')
  );
$$;

-- Service role only, revoked by name as well as from `public`, because
-- Supabase grants new functions to `anon` and `authenticated` directly.
revoke all on function byollm_charge_tool_call(uuid, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function byollm_tool_jobs_in_flight() from public, anon, authenticated;
revoke all on function byollm_tool_charges_end_with_job() from public, anon, authenticated;
grant execute on function byollm_charge_tool_call(uuid, text, integer, timestamptz) to service_role;
grant execute on function byollm_tool_jobs_in_flight() to service_role;
