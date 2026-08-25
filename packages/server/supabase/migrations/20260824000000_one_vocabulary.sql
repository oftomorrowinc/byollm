-- One sharing vocabulary, in the database too — byollm_016.
--
-- `private | team | public` replaced `self | named | public` everywhere else
-- in this release. The enums did not move with it, and the gap was invisible
-- to `pnpm run verify`: the TypeScript compiled, the unit suites passed
-- against the in-memory store, and only the freeze gate — which runs the same
-- code against real Postgres — refused the insert with `invalid input value
-- for enum byollm_audience: "private"`. A schema is not typechecked by the
-- language that talks to it.
--
-- Values are renamed rather than the enums recreated. `alter type ... rename
-- value` keeps every existing row's identity: the label changes, the stored
-- value does not move, and nothing has to be rewritten or backfilled. A
-- drop-and-recreate would need every column that uses the type dropped first,
-- which is how a rename turns into data loss.
--
-- Landing in one step, with the code that reads it, for the reason
-- `20260821000000_rename_collected` gives: transitional shapes exist to
-- protect a party who has not agreed to change, and pre-1.0 that party is us.

alter type byollm_audience rename value 'self' to 'private';
alter type byollm_audience rename value 'named' to 'team';

alter type byollm_offer_scope rename value 'self' to 'private';
alter type byollm_offer_scope rename value 'named' to 'team';

-- The column default is stored as a reference to the value, not as its text,
-- so the rename already carried it. Restated anyway: a default that reads
-- `'self'` in a dump nobody re-ran is exactly the kind of thing that gets
-- copied into the next schema.
alter table byollm_jobs
  alter column audience set default 'private';

comment on column byollm_jobs.audience is
  'Who this job may run for: private (the owner alone), team (the owner and '
  'the named allowlist), public (anyone). byollm_016; these were self/named.';

-- Recreated whole rather than patched — two functions with one name is how a
-- caller ends up invoking the one nobody maintains. The logic is unchanged;
-- only the vocabulary moves.
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
  if p_job.audience = 'private' and not v_same_owner then
    return false;
  end if;
  if p_job.audience = 'team'
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
  if v_scope = 'private' then
    return false;
  end if;
  if v_scope = 'team' then
    -- The server cannot verify a remote daemon's local allowlist and must not
    -- pretend to. It offers the job; the daemon refuses if its own list says
    -- no, and the refusal is remembered in refused_by. In this build that
    -- allowlist is the *only* enforcement — there is no central roster yet.
    return true;
  end if;
  return v_scope = 'public';
end;
$$;

revoke all on function byollm_audience_admits(byollm_jobs, uuid, uuid, jsonb) from public;
