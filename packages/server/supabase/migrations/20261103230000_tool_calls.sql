-- A short-lived row per tool call in flight — byollm_012 §5.2, byollm_021 R1.
--
-- On the direct lane this database is the upstream for the four tool
-- endpoints: the daemon's `tool-call` writes a row, the site's `calls` reads
-- the outstanding ones, the site's `tool-result` answers one, and the
-- daemon's `tool-results` reads the answers. `MemoryStore` (src/memory.ts)
-- is the reference; this is the same contract, row for row.
--
-- Every envelope stays sealed. A call is sealed by the device to the site, a
-- result by the site to the device, and nothing here can open either.
--
-- ## Bound to the grant, deleted with the job
--
-- A row names the lease it was made under. Every read and every answer
-- filters on the job's CURRENT lease, so a grant that ends (a lapse, a
-- release) takes its calls out of reach at once: nothing lists them and
-- nothing can answer them. The rows stay until the job ends only so the
-- job's call budget can be counted across grants — a budget that restarted
-- with every grant would let a modified daemon release, re-claim and spend
-- the site's tools again.
--
-- They go with the job: `on delete cascade` for a deleted job, and the
-- trigger below for a job that reaches a terminal state, which is when a job
-- ends here (rows in `byollm_jobs` are kept, not deleted).
--
-- ## Atomic, like claim
--
-- `byollm_record_tool_call` locks the job row, so the count and the insert
-- are one step and two concurrent calls cannot both take the last slot of a
-- budget (TOOLS_BUDGETED). Time comes from the caller (`p_now`), as
-- `renewLeases` takes it, so the timeout this table stamps and the one the
-- handler reports are read from one clock.
--
-- Only the service role reaches this table: RLS is on and no policy grants
-- anything to a browser session. Tool traffic is between a device and a
-- site's server, and nobody's dashboard reads it.

create table byollm_tool_calls (
  job_id      uuid not null references byollm_jobs (id) on delete cascade,
  -- The daemon's id for the call: random, single-use, 16 to 128 base64url
  -- characters (`ToolCallId` in @byollm/protocol).
  call_id     text not null
                check (call_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- The grant the call was made under. No foreign key: a lease is a column
  -- of `byollm_jobs`, not a row of its own.
  lease_id    uuid not null,
  -- Sealed by the device to the site, direction `tool-call`.
  envelope    jsonb not null,
  -- Sealed by the site to the device, direction `tool-result`, once answered.
  result      jsonb,
  created_at  timestamptz not null,
  -- When the call stops being outstanding: TOOL_CALL_TIMEOUT after it was
  -- written. Past it, an answer is refused as too late.
  expires_at  timestamptz not null,
  answered_at timestamptz,
  primary key (job_id, call_id)
);

create index byollm_tool_calls_waiting_idx
  on byollm_tool_calls (expires_at)
  where result is null;

alter table byollm_tool_calls enable row level security;

-- ---------------------------------------------------------------------------
-- Deleted with its job
-- ---------------------------------------------------------------------------

create or replace function byollm_tool_calls_end_with_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state in ('ok', 'error', 'canceled', 'expired') then
    delete from byollm_tool_calls where job_id = new.id;
  end if;
  return new;
end;
$$;

create trigger byollm_jobs_tool_calls_end
  after update of state on byollm_jobs
  for each row
  when (new.state is distinct from old.state)
  execute function byollm_tool_calls_end_with_job();

-- ---------------------------------------------------------------------------
-- tool-call: one sealed call, counted and kept
-- ---------------------------------------------------------------------------
--
-- Returns one jsonb: `{ "refused": "not-found" | "not-tools" | "budget" |
-- "call-conflict" }`, or `{ "row": <the row>, "duplicate": bool }`. The
-- order of the refusals is the contract's (src/store.ts, `recordToolCall`).

create or replace function byollm_record_tool_call(
  p_job_id        uuid,
  p_runner_id     uuid,
  p_lease_id      uuid,
  p_call_id       text,
  p_envelope      jsonb,
  p_max_tool_calls integer,
  p_timeout_ms    integer,
  p_now           timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job   byollm_jobs;
  v_known byollm_tool_calls;
  v_made  integer;
  v_row   byollm_tool_calls;
begin
  -- Locked, so the count below and the insert are one step.
  select * into v_job from byollm_jobs where id = p_job_id for update;

  -- One answer for unknown, not yours and stale, as `fetch` gives.
  if v_job.id is null
     or v_job.lease_runner is distinct from p_runner_id
     or v_job.lease_id is distinct from p_lease_id
     or v_job.state not in ('claimed', 'running') then
    return jsonb_build_object('refused', 'not-found');
  end if;
  if v_job.kind <> 'llm.tools' then
    return jsonb_build_object('refused', 'not-tools');
  end if;

  select * into v_known
    from byollm_tool_calls
   where job_id = p_job_id and call_id = p_call_id;
  if v_known.job_id is not null then
    -- A replay of the same signed request is the call it replays; a
    -- different envelope under a used id is refused. Neither is counted.
    if v_known.lease_id = p_lease_id and v_known.envelope = p_envelope then
      return jsonb_build_object('row', to_jsonb(v_known), 'duplicate', true);
    end if;
    return jsonb_build_object('refused', 'call-conflict');
  end if;

  -- Counted before the write, over every grant the job has had.
  select count(*) into v_made from byollm_tool_calls where job_id = p_job_id;
  if v_made >= p_max_tool_calls then
    return jsonb_build_object('refused', 'budget');
  end if;

  insert into byollm_tool_calls
    (job_id, call_id, lease_id, envelope, created_at, expires_at)
  values
    (p_job_id, p_call_id, p_lease_id, p_envelope, p_now,
     p_now + (p_timeout_ms || ' milliseconds')::interval)
  returning * into v_row;

  return jsonb_build_object('row', to_jsonb(v_row), 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- calls: what is outstanding, under each job's current grant
-- ---------------------------------------------------------------------------

create or replace function byollm_outstanding_tool_calls(p_now timestamptz)
returns setof byollm_tool_calls
language sql
stable
security definer
set search_path = public
as $$
  select c.*
    from byollm_tool_calls c
    join byollm_jobs j on j.id = c.job_id
   where c.lease_id = j.lease_id
     and c.result is null
     and c.expires_at > p_now
   order by c.created_at;
$$;

-- ---------------------------------------------------------------------------
-- tool-result: the site's answer, only for an outstanding call of that job
-- ---------------------------------------------------------------------------
--
-- Returns 'accepted', 'not-found' or 'too-late'. Found by (job, call) under
-- the job's current lease, so another job's call id, a call from a grant
-- that ended and a call of a job that ended are all `not-found`.

create or replace function byollm_answer_tool_call(
  p_job_id   uuid,
  p_call_id  text,
  p_envelope jsonb,
  p_now      timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row byollm_tool_calls;
begin
  select c.* into v_row
    from byollm_tool_calls c
    join byollm_jobs j on j.id = c.job_id
   where c.job_id = p_job_id
     and c.call_id = p_call_id
     and c.lease_id = j.lease_id
     for update of c;

  if v_row.job_id is null then
    return 'not-found';
  end if;
  if v_row.result is not null then
    -- The same answer again is a replay, written once; a different one is a
    -- second answer to a call that already has one.
    return case when v_row.result = p_envelope then 'accepted' else 'too-late' end;
  end if;
  if v_row.expires_at <= p_now then
    return 'too-late';
  end if;

  update byollm_tool_calls
     set result = p_envelope,
         answered_at = p_now
   where job_id = p_job_id and call_id = p_call_id;
  return 'accepted';
end;
$$;

-- ---------------------------------------------------------------------------
-- tool-results: answers, to the runner holding each named grant
-- ---------------------------------------------------------------------------
--
-- `p_calls` is a jsonb array of `{ jobId, leaseId, callId }`. A call comes
-- back only if `p_runner_id` holds that lease on that job now, the call was
-- made under it, and it has been answered. Anything else is left out.

create or replace function byollm_tool_results(
  p_runner_id uuid,
  p_calls     jsonb
)
returns setof byollm_tool_calls
language sql
stable
security definer
set search_path = public
as $$
  select c.*
    from jsonb_to_recordset(p_calls)
           as named ("jobId" text, "leaseId" text, "callId" text)
    join byollm_jobs j
      on j.id::text = named."jobId"
     and j.lease_id::text = named."leaseId"
     and j.lease_runner = p_runner_id
    join byollm_tool_calls c
      on c.job_id = j.id
     and c.call_id = named."callId"
     and c.lease_id = j.lease_id
   where c.result is not null;
$$;

-- Service role only: these are called by the protocol handler, never by a
-- browser session. Revoked from `anon` and `authenticated` by name as well as
-- from `public`, because Supabase grants new functions to both directly.
revoke all on function byollm_record_tool_call(uuid, uuid, uuid, text, jsonb, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function byollm_outstanding_tool_calls(timestamptz) from public, anon, authenticated;
revoke all on function byollm_answer_tool_call(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function byollm_tool_results(uuid, jsonb) from public, anon, authenticated;
revoke all on function byollm_tool_calls_end_with_job() from public, anon, authenticated;
grant execute on function byollm_record_tool_call(uuid, uuid, uuid, text, jsonb, integer, integer, timestamptz) to service_role;
grant execute on function byollm_outstanding_tool_calls(timestamptz) to service_role;
grant execute on function byollm_answer_tool_call(uuid, text, jsonb, timestamptz) to service_role;
grant execute on function byollm_tool_results(uuid, jsonb) to service_role;
