-- A job names one of the *site's* declared purposes — byollm_016 Amendment L.
--
-- This replaces `service`, added two days ago, which named one of the device
-- owner's advertised services. That was safe because it was a key rather than
-- a value — a name from somebody's own config, meaningless off their machine.
-- Amendment L goes further: a site does not name the owner's things at all.
-- It declares purposes of its own, each person maps those purposes to their
-- own services on the consent screen, and a control plane joins the two when
-- it signs a grant.
--
-- So the vocabulary that crossed the boundary no longer does. The refusal
-- machinery that existed to stop a site probing service names — one collapsed
-- reason for "no such service" and "not offered to you" — retires with it,
-- because a name that never crosses cannot be enumerated across.
--
-- Renamed rather than dropped-and-added: the column's *shape* is unchanged
-- (nullable text, no default, null meaning "nothing named") and a rename
-- keeps every row's identity, its grants and its policies. What changes is
-- whose namespace the string belongs to.
--
-- **The values are not migrated, and that is deliberate.** Any row still
-- holding a service name holds a name from the wrong namespace: it is one of
-- the device owner's services, and this column now means one of the site's
-- purposes. There is no mapping between them that this migration could know.
-- Pre-1.0, nothing has shipped with either, and a null here reads as "named
-- nothing" — which is the truth about a job enqueued before purposes existed.

alter table byollm_jobs
  rename column service to purpose;

update byollm_jobs set purpose = null where purpose is not null;

comment on column byollm_jobs.purpose is
  'Which of the enqueuing site''s declared purposes this job serves. Null '
  'means it named none. A key in the site''s own namespace — never a service, '
  'model or URL — byollm_016 Amendment L.';
