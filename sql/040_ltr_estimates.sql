-- 040 — ltr_estimates: RentCast long-term-rent estimates per deal.
--
-- The long-term twin of 039's str_estimates (AirDNA). Append-only: every pull
-- is a new row, so a deal's LTR rent is TRACKED over time — the scheduled
-- rent-estimates-sync re-pulls each single-family deal every 30 days, and the
-- dashboard shows the change since the previous pull. The newest row per
-- card_id is the current estimate.
--
-- Written only by netlify/functions/rent-estimate.js and rent-estimates-sync.js
-- (service key) through lib/rentcast.js. The dashboard reads it and fails soft
-- before this migration runs. `raw` keeps RentCast's whole response, including
-- the comparables, so history can be re-derived rather than re-bought.

create table if not exists ltr_estimates (
  id              bigint generated always as identity primary key,
  card_id         text   not null,
  provider        text   not null default 'rentcast',
  status          text   not null,                -- ok | error
  address         text   not null default '',     -- exactly what was sent
  bedrooms        numeric,
  bathrooms       numeric,
  square_feet     int,
  rent            numeric,                        -- monthly, the AVM point estimate
  rent_low        numeric,
  rent_high       numeric,
  comps_count     int,
  error           text   not null default '',
  raw             jsonb,
  fetched_at      timestamptz not null default now()
);

create index if not exists idx_ltr_estimates_card_time
  on ltr_estimates (card_id, fetched_at desc);

alter table ltr_estimates enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ltr_estimates'
      and policyname = 'authenticated_full_access_ltr_estimates'
  ) then
    execute 'create policy "authenticated_full_access_ltr_estimates" on ltr_estimates
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;

insert into schema_migrations (filename) values ('040_ltr_estimates.sql')
on conflict do nothing;
