-- Properties never disappeared from the dashboard when a card was moved off
-- the "Under Contract" Trello list, because sync-trello only ever ADDED/
-- UPDATED cards it saw — it had no way to notice a card was gone. This adds
-- an archived flag the sync can set, and the dashboard filters on it.
alter table properties add column if not exists archived boolean default false;
alter table properties add column if not exists archived_at timestamptz;

create index if not exists properties_archived_idx on properties (archived);
