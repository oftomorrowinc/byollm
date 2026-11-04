-- The site SDK's tool SQL, probed — 20261104010000_tool_charges.sql (#6933 card 4).
--
-- Every answer in the store contract (src/store.ts, `chargeToolCall` and
-- `toolJobsInFlight`): a charge counted once, the budget, a closed job,
-- deletion when the job ends, which states are in flight, and that only the
-- service role may call the functions. Inside one transaction that ROLLS
-- BACK, so it leaves nothing in the database it is run against; the
-- migration is included inside it when the database does not have it yet.
--
-- Run against the local stack (`supabase status` names the container):
--
--   docker exec -i supabase_db_byollm psql -U postgres -d postgres -At \
--     -v migration="$(cat ../migrations/20261104010000_tool_charges.sql)" \
--     < tool-charges.sql
--
-- Each line prints `name|value`; read them against the expectations beside
-- each probe. Not run by `verify`, as nothing of the Supabase adapter is.

\set ON_ERROR_STOP on
begin;
select to_regclass('public.byollm_tool_charges') is null as missing \gset
\if :missing
:migration
\endif
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'chargetest@byollm.test');
insert into byollm_jobs (id, kind, envelope, size_class, owner, state)
  values ('33333333-3333-3333-3333-333333333333','llm.tools','{}','small','11111111-1111-1111-1111-111111111111','queued'),
         ('55555555-5555-5555-5555-555555555555','llm.chat','{}','small','11111111-1111-1111-1111-111111111111','queued');
-- expect: t (a queued tool job is in flight)
select 'in flight, queued', byollm_tool_jobs_in_flight();
-- expect: {"charged": 1}
select 'charge 1', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-aaaaaaaaaaaaaaaa',2, now());
-- expect: {"charged": 1} (the same call again: counted once)
select 'charge 1 again', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-aaaaaaaaaaaaaaaa',2, now());
-- expect: {"charged": 2}
select 'charge 2', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-bbbbbbbbbbbbbbbb',2, now());
-- expect: {"refused": "budget"}
select 'budget', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-cccccccccccccccc',2, now());
-- expect: {"charged": 2} (a charged call may be run again)
select 'charge 2 again', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-bbbbbbbbbbbbbbbb',2, now());
-- expect: {"refused": "closed"}
select 'unknown job', byollm_charge_tool_call('99999999-9999-9999-9999-999999999999','call-aaaaaaaaaaaaaaaa',2, now());
update byollm_jobs set state = 'canceled' where id = '33333333-3333-3333-3333-333333333333';
-- expect: 0 (charges end with the job)
select 'rows after cancel', count(*) from byollm_tool_charges where job_id = '33333333-3333-3333-3333-333333333333';
-- expect: {"refused": "closed"}
select 'closed job', byollm_charge_tool_call('33333333-3333-3333-3333-333333333333','call-dddddddddddddddd',2, now());
-- expect: f (the only open job is a chat job)
select 'in flight, none', byollm_tool_jobs_in_flight();
-- expect: f, f (anon may execute neither)
select 'anon charge', has_function_privilege('anon', 'byollm_charge_tool_call(uuid, text, integer, timestamptz)', 'execute');
select 'anon in flight', has_function_privilege('anon', 'byollm_tool_jobs_in_flight()', 'execute');
-- expect: t, t (the service role may)
select 'service charge', has_function_privilege('service_role', 'byollm_charge_tool_call(uuid, text, integer, timestamptz)', 'execute');
select 'service in flight', has_function_privilege('service_role', 'byollm_tool_jobs_in_flight()', 'execute');
rollback;
