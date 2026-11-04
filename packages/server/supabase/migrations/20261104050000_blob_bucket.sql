-- Blobs, by reference — byollm_021 §2, ruled on #6933 (2026-11-03).
--
-- An `llm.vision` job's input images and an `llm.image` job's output images
-- travel as encrypted blobs, each under its own key, and the key travels only
-- inside the job's sealed, signed envelope (BLOBS_SEALED). So everything this
-- file creates holds ciphertext and bookkeeping, and nothing that opens it.
--
-- Two pieces:
--
--   1. `byollm-blobs`, a private Storage bucket, one object per blob id. Only
--      the service role reaches it: the adapter runs as the service role,
--      and no browser, signed in or not, has any business reading anybody's
--      ciphertext. Storage RLS already denies a role with no policy; the
--      restrictive policy below makes that hold even after somebody adds a
--      broad permissive policy on `storage.objects` for their own buckets,
--      which is an ordinary thing to do and would otherwise open this one.
--
--   2. `byollm_blobs`, a row per blob: its job, its direction, the size its
--      slot was issued for, the size actually stored, and when it is deleted
--      whatever else happens. No foreign key to `byollm_jobs`: a site's input
--      blobs are uploaded before their job exists, which is what lets the
--      upload overlap the wait. RLS on, no policies — service role only.
--
-- The deletion order (§2) is the adapter's and the app's, not a trigger's:
-- inputs go when the result is accepted, outputs when the site says it holds
-- them or an hour after collection, and anything left a day after its job's
-- deadline (`delete_at`, swept by `ByollmApp.sweep`).

insert into storage.buckets (id, name, public, file_size_limit)
values (
  'byollm-blobs',
  'byollm-blobs',
  false,
  -- One image at the cap, padded, plus nonce and tag: MAX_BLOB_OBJECT_BYTES.
  20971560
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create policy byollm_blobs_service_role_only
  on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id <> 'byollm-blobs')
  with check (bucket_id <> 'byollm-blobs');

create table byollm_blobs (
  id            text primary key,
  job_id        text not null,
  direction     text not null check (direction in ('in', 'out')),
  slot_bytes    integer not null check (slot_bytes > 0),
  stored_bytes  integer check (stored_bytes is null or stored_bytes >= 0),
  delete_at     timestamptz not null,
  created_at    timestamptz not null default now()
);

create index byollm_blobs_job on byollm_blobs (job_id, direction);
create index byollm_blobs_delete_at on byollm_blobs (delete_at);

alter table byollm_blobs enable row level security;
