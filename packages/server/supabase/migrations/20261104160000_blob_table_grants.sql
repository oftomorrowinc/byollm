-- `byollm_blobs`'s privileges, granted deliberately — found cutting
-- `0.1.5-beta.1` (#7060).
--
-- `20261104050000_blob_bucket.sql` created the table with RLS on and no
-- policies, and granted nothing. Every other table the adapter reads with
-- `.from(...)` takes its operations from an explicit GRANT (the house rule,
-- `20260809000000_byollm_runner.sql` §Grants), because Supabase images differ
-- in what `ALTER DEFAULT PRIVILEGES` hands out. An older local image grants
-- `service_role` everything on a new public table, so the blob checks passed
-- on a laptop; the image CI's pinned CLI runs grants nothing, so the service
-- role was refused its own table — `permission denied for table byollm_blobs`
-- on C048, C053, C054, C057 and C059, and on every check whose cleanup sweeps
-- blobs (C004, C012, C013, C020). main was red from #7057 until this.
--
-- A new file rather than an edit to the old one: a database that already
-- applied `20261104050000` never re-reads it.
--
-- Revoke first, then grant, as the first migration does, so `anon` and
-- `authenticated` hold nothing here whichever image created the table. RLS
-- would refuse them every row anyway; this makes "a browser reaches no blob
-- row" true of the operations too, not only of the rows.

revoke all on byollm_blobs from anon, authenticated;

grant select, insert, update, delete on byollm_blobs to service_role;
