-- The tool-call SQL, probed — 20261103230000_tool_calls.sql (#6933 card 2).
--
-- Every refusal in the store contract (src/store.ts, the tool-call methods),
-- the call timeout, a requeue's calls out of reach but still counted,
-- deletion when the job ends, and that only the service role may call the
-- functions. Inside one transaction that ROLLS BACK, so it leaves nothing in
-- the database it is run against; the migration is included inside it when
-- the database does not have it yet.
--
-- Run against the local stack (`supabase status` names the container):
--
--   docker exec -i supabase_db_byollm psql -U postgres -d postgres -At \
--     -v migration="$(cat ../migrations/20261103230000_tool_calls.sql)" \
--     < tool-calls.sql
--
-- Each line prints `name|value`; read them against the expectations beside
-- each probe. Not run by `verify`, as nothing of the Supabase adapter is.

\set ON_ERROR_STOP on
begin;
select to_regclass('public.byollm_tool_calls') is null as missing \gset
\if :missing
:migration
\endif
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'tooltest@byollm.test');
insert into byollm_runners (id, owner, label, platform, daemon_version, device)
  values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','t','darwin','0.1.5','{}');
insert into byollm_jobs (id, kind, envelope, size_class, owner, state, lease_id, lease_runner, lease_expires_at)
  values ('33333333-3333-3333-3333-333333333333','llm.tools','{}','small','11111111-1111-1111-1111-111111111111','running','44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222', now() + interval '1 minute'),
         ('55555555-5555-5555-5555-555555555555','llm.chat','{}','small','11111111-1111-1111-1111-111111111111','running','66666666-6666-6666-6666-666666666666','22222222-2222-2222-2222-222222222222', now() + interval '1 minute');
-- expect: false
select 'record 1', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-aaaaaaaaaaaaaaaa','{"c":1}',2,60000, now())->>'duplicate';
-- expect: true
select 'replay', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-aaaaaaaaaaaaaaaa','{"c":1}',2,60000, now())->>'duplicate';
-- expect: call-conflict
select 'conflict', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-aaaaaaaaaaaaaaaa','{"c":2}',2,60000, now())->>'refused';
-- expect: false
select 'record 2', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-bbbbbbbbbbbbbbbb','{"c":3}',2,60000, now())->>'duplicate';
-- expect: budget
select 'budget', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','call-cccccccccccccccc','{"c":4}',2,60000, now())->>'refused';
-- expect: not-tools
select 'not-tools', byollm_record_tool_call('55555555-5555-5555-5555-555555555555','22222222-2222-2222-2222-222222222222','66666666-6666-6666-6666-666666666666','call-dddddddddddddddd','{"c":5}',2,60000, now())->>'refused';
-- expect: not-found
select 'stale lease', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','66666666-6666-6666-6666-666666666666','call-eeeeeeeeeeeeeeee','{"c":6}',2,60000, now())->>'refused';
-- expect: 2
select 'outstanding', count(*) from byollm_outstanding_tool_calls(now());
-- expect: 0
select 'outstanding later', count(*) from byollm_outstanding_tool_calls(now() + interval '61 seconds');
-- expect: not-found
select 'answer other job', byollm_answer_tool_call('55555555-5555-5555-5555-555555555555','call-aaaaaaaaaaaaaaaa','{"r":1}', now());
-- expect: accepted
select 'answer', byollm_answer_tool_call('33333333-3333-3333-3333-333333333333','call-aaaaaaaaaaaaaaaa','{"r":1}', now());
-- expect: accepted
select 'answer again same', byollm_answer_tool_call('33333333-3333-3333-3333-333333333333','call-aaaaaaaaaaaaaaaa','{"r":1}', now());
-- expect: too-late
select 'answer again different', byollm_answer_tool_call('33333333-3333-3333-3333-333333333333','call-aaaaaaaaaaaaaaaa','{"r":2}', now());
-- expect: too-late
select 'answer late', byollm_answer_tool_call('33333333-3333-3333-3333-333333333333','call-bbbbbbbbbbbbbbbb','{"r":3}', now() + interval '61 seconds');
-- expect: 1
select 'results mine', count(*) from byollm_tool_results('22222222-2222-2222-2222-222222222222', '[{"jobId":"33333333-3333-3333-3333-333333333333","leaseId":"44444444-4444-4444-4444-444444444444","callId":"call-aaaaaaaaaaaaaaaa"}]');
-- expect: 0
select 'results wrong lease', count(*) from byollm_tool_results('22222222-2222-2222-2222-222222222222', '[{"jobId":"33333333-3333-3333-3333-333333333333","leaseId":"66666666-6666-6666-6666-666666666666","callId":"call-aaaaaaaaaaaaaaaa"}]');
-- expect: 0
select 'results other job', count(*) from byollm_tool_results('22222222-2222-2222-2222-222222222222', '[{"jobId":"55555555-5555-5555-5555-555555555555","leaseId":"66666666-6666-6666-6666-666666666666","callId":"call-aaaaaaaaaaaaaaaa"}]');
-- requeue: new lease; old calls out of reach but counted
update byollm_jobs set lease_id = '77777777-7777-7777-7777-777777777777' where id = '33333333-3333-3333-3333-333333333333';
-- expect: not-found
select 'after requeue answer', byollm_answer_tool_call('33333333-3333-3333-3333-333333333333','call-bbbbbbbbbbbbbbbb','{"r":3}', now());
-- expect: 0
select 'after requeue outstanding', count(*) from byollm_outstanding_tool_calls(now());
-- expect: budget
select 'after requeue budget', byollm_record_tool_call('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','77777777-7777-7777-7777-777777777777','call-ffffffffffffffff','{"c":7}',2,60000, now())->>'refused';
update byollm_jobs set state = 'ok' where id = '33333333-3333-3333-3333-333333333333';
-- expect: 0
select 'rows after ok', count(*) from byollm_tool_calls;
-- expect: f
select 'anon can execute', has_function_privilege('anon', 'byollm_record_tool_call(uuid, uuid, uuid, text, jsonb, integer, integer, timestamptz)', 'execute');
-- expect: t
select 'service can execute', has_function_privilege('service_role', 'byollm_record_tool_call(uuid, uuid, uuid, text, jsonb, integer, integer, timestamptz)', 'execute');
rollback;
