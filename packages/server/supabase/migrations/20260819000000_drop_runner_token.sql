-- The bearer token nobody used — cloud_008 §2.4, finding 37.
--
-- `byollm_runners.token_hash` held the SHA-256 of a token minted at pairing,
-- returned to the daemon, written to its pairings file, and then **never
-- sent, never looked up and never compared**. The only reader was
-- `getRunnerByTokenHash`, which both store adapters implemented and nothing
-- called except a test asserting it returns null.
--
-- That is not dead wire in the ordinary sense. It was a *secret*: minted,
-- transmitted once, and written to two disks at rest for no purpose. A
-- credential with no consumer cannot be used correctly and can still leak,
-- which makes it strictly a liability.
--
-- `REQUESTS_SIGNED_NOT_BEARER` was the rule the whole time and was enforced
-- the whole time: every authenticated call is signed by the device's pinned
-- identity key, and `C016` proves an endpoint refuses a bearer token. This
-- drops the thing the MUST is named after.
--
-- `byollm_pairings.runner_token_once` stays and now carries a marker rather
-- than a secret. It is the deliver-once flag — a replayed device code must
-- get nothing — a real property that was riding on the token's nullability.
-- Renaming a column and changing the code that reads it in one step is how a
-- rollback strands rows, so the rename waits for a later release.

alter table byollm_runners drop column if exists token_hash;

-- The browser-facing approval path takes one fewer argument. Replaced with
-- the old signature dropped rather than left beside it: two functions with
-- one name is how a caller ends up invoking the one nobody maintains.
--
-- Everything else is unchanged from the original, deliberately — the owner
-- still comes from `auth.uid()` because a daemon can never assert who it is,
-- which is the whole reason pairing is interactive.
drop function if exists byollm_approve_pairing(text, text);

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
         runner_token_once = 'pending-collection'
   where device_code_hash = v_pairing.device_code_hash;

  return v_runner;
end;
$$;
