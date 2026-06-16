-- Buyer-inflow staging. Scraped InvestorLift hot buyers (and other cold
-- prospects) land HERE, not in `buyers`, so they never hit a deal blast until
-- they've been contacted and qualified. Flow: new -> contacted -> responded ->
-- promoted (copied into `buyers`) | dismissed.
create table if not exists leads (
    id           bigint generated always as identity primary key,
    name         text    default '',
    email        text    default '',
    phone        text    default '',
    states       text    default '',
    source       text    default '',        -- investorlift | facebook | batchleads | …
    deal_id      text    default '',         -- IL property id they were hot on
    deal_address text    default '',         -- human label for that deal, if known
    status       text    default 'new',      -- new | contacted | responded | promoted | dismissed
    notes        text    default '',
    contacted_at timestamptz,
    responded_at timestamptz,
    promoted_at  timestamptz,
    created_at   timestamptz default now()
);

create index if not exists leads_status_idx on leads (status);
create unique index if not exists leads_email_uniq on leads (lower(email)) where email <> '';

alter table leads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'leads'
      and policyname = 'authenticated_all_leads'
  ) then
    execute 'create policy "authenticated_all_leads" on leads
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
