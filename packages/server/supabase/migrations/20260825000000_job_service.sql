-- A job may name which service should answer it — byollm_016 Phase B.
--
-- Nullable with no default, and the null means something specific: this job
-- named nothing, so the device owner's default answers. That is every job
-- enqueued before this column existed, which is why there is no backfill —
-- the absent value already says the right thing about them.
--
-- A *key* rather than a value. It holds a name from the device owner's own
-- config, so it means nothing off that machine and resolves through their
-- config or resolves nowhere. No model, no base URL, no flags: the amended
-- NO_PAYLOAD_ROUTING permits selection and forbids description, and a column
-- that could hold `claude-opus-5` would be the wrong shape for that rule.

alter table byollm_jobs
  add column if not exists service text;

comment on column byollm_jobs.service is
  'Which of the device owner''s advertised services should answer. Null means '
  'their default. A key from their config, never a model or URL — byollm_016 '
  'Phase B, byollm_009 Amendment D.';
