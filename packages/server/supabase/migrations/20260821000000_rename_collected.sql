-- The deliver-once flag stops pretending to be a token — cloud_008 §2.4a.
--
-- `20260819000000_drop_runner_token` removed the bearer credential and left
-- `byollm_pairings.runner_token_once` carrying a marker string, with the
-- reason written down: *"Renaming a column and changing the code that reads
-- it in one step is how a rollback strands rows, so the rename waits for a
-- later release."*
--
-- This is that release. The rename lands with the code that reads it, in one
-- step, because the transitional shape exists to protect a party who has not
-- agreed to change — and pre-1.0, with one deployment and one operator, that
-- party is us. Carrying a column named after a secret it no longer holds is
-- a comment that has to be re-read by everybody who meets it.
--
-- The property is unchanged and is the reason the column survives at all: a
-- replayed device code must get nothing, or a code left in a shell history is
-- a second pairing. That was riding on a token's nullability, which was one
-- field doing two jobs — and only one of them load-bearing.

alter table byollm_pairings
  rename column runner_token_once to collected_at;

-- A timestamp rather than a marker string. `'pending-collection'` was the
-- shape a nulled token left behind; what the flag actually records is *when*
-- the approval was handed over, which is worth having when somebody asks why
-- a pairing did not complete.
alter table byollm_pairings
  alter column collected_at type timestamptz
  using case when collected_at is null then now() else null end;

comment on column byollm_pairings.collected_at is
  'When the approval was collected. Null until then — a replayed device code '
  'gets nothing. cloud_008 §2.4a; this was runner_token_once.';

-- The approval function moves with the column it writes. Recreated whole
-- rather than patched, because two functions with one name is how a caller
-- ends up invoking the one nobody maintains — the argument the migration
-- before this one made when it replaced the old signature.

create or replace function byollm_approve_pairing(
  p_user_code text
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

  insert into byollm_runners (owner, label, platform,
                              daemon_version, capabilities, device)
  values (v_owner, v_pairing.label, v_pairing.platform,
          v_pairing.daemon_version, v_pairing.capabilities, v_pairing.device)
  returning * into v_runner;

  -- The marker, not a token: this is what makes a replayed device code get
  -- nothing. The service-role path in `supabase/index.ts` writes the same
  -- value, and the two approval doors have to agree — a field set by one and
  -- not the other produces a runner that is correct through one and broken
  -- through the other.
  update byollm_pairings
     set state = 'approved',
         owner = v_owner,
         runner_id = v_runner.id,
         collected_at = null
   where device_code_hash = v_pairing.device_code_hash;

  return v_runner;
end;
$$;

