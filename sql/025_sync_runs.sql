-- 025 — Sync heartbeat log.
-- One row per scheduled-function run (sync-trello / sync-buyers /
-- capture-replies), written by netlify/functions/lib/heartbeat.js. Powers the
-- "last synced" indicator in the dashboard header and the consecutive-failure
-- email alert. Without this, a dead sync fails silently and the board rots.

create table if not exists sync_runs (
  id      bigint generated always as identity primary key,
  fn      text not null,                                   -- function name, e.g. 'sync-trello'
  status  text not null check (status in ('ok', 'error')),
  detail  text default '',                                 -- run summary or error message
  ran_at  timestamptz default now()
);

create index if not exists idx_sync_runs_fn_ran on sync_runs (fn, ran_at desc);

alter table sync_runs enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sync_runs'
      and policyname = 'authenticated_full_access_sync_runs'
  ) then
    execute 'create policy "authenticated_full_access_sync_runs" on sync_runs
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
