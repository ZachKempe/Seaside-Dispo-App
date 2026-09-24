-- 039 — str_estimates: AirDNA Rentalizer short-term-rental estimates per deal.
--
-- Append-only: every pull is a new row, so a deal's STR outlook is TRACKED over
-- time (the scheduled str-estimates-sync refreshes each single-family deal
-- every 30 days). The newest row per card_id is the current estimate.
--
-- Written only by netlify/functions/str-estimate.js and str-estimates-sync.js
-- (service key) through lib/airdna.js. The dashboard reads it and fails soft
-- before this migration runs.
--
-- `raw` keeps AirDNA's whole payload: their response schema isn't public, so
-- if the parser ever misreads a field, the history can be re-derived rather
-- than re-bought.

create table if not exists str_estimates (
  id              bigint generated always as identity primary key,
  card_id         text   not null,
  provider        text   not null default 'airdna',
  status          text   not null,                -- ok | error
  address         text   not null default '',     -- exactly what was sent
  bedrooms        int,
  bathrooms       numeric,
  accommodates    int,
  annual_revenue  numeric,                        -- gross, trailing/projected 12 mo
  adr             numeric,                        -- average daily rate
  occupancy       numeric,                        -- 0..1
  comps_count     int,
  error           text   not null default '',
  raw             jsonb,
  fetched_at      timestamptz not null default now()
);

create index if not exists idx_str_estimates_card_time
  on str_estimates (card_id, fetched_at desc);

alter table str_estimates enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'str_estimates'
      and policyname = 'authenticated_full_access_str_estimates'
  ) then
    execute 'create policy "authenticated_full_access_str_estimates" on str_estimates
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;

insert into schema_migrations (filename) values ('039_str_estimates.sql')
on conflict do nothing;
