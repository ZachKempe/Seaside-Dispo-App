-- Seaside Dispo — Pipeline tracking + per-deal analytics support
--
-- 1) deal_leads: a unified "who's interested in this deal" pipeline.
--    Captures EVERYONE regardless of where they came from — your buyer-list
--    blasts, InvestorLift, CreativeListing, Facebook groups, referrals, etc.
--    Known buyers link via buyer_id (so you inherit their tier/contact for
--    free); leads from other platforms are logged manually with name+contact.
--
-- 2) deal_blasts gains variation_index/variation_title so you can see which
--    of the 3 marketing-copy variations drove the best response per deal.

create table if not exists deal_leads (
    id          bigint generated always as identity primary key,
    card_id     text    not null,
    address     text    default '',
    buyer_id    bigint  references buyers(id) on delete set null,  -- null = external lead (not in buyer DB)
    name        text    not null,
    contact     text    default '',          -- email/phone for external leads (buyers pull from buyers table)
    source      text    not null default 'buyer_blast',  -- buyer_blast | investorlift | creativelisting | fb_group | referral | other
    channel     text    default '',          -- email | sms | dm | call | in_person
    stage       text    not null default 'new',  -- new | responded | interested | offer | under_contract | closed | dead
    notes       text    default '',
    created_at  timestamptz default now(),
    updated_at  timestamptz default now()
);

create index if not exists idx_deal_leads_card_id  on deal_leads(card_id);
create index if not exists idx_deal_leads_buyer_id on deal_leads(buyer_id);
create index if not exists idx_deal_leads_stage    on deal_leads(stage);

alter table deal_blasts add column if not exists variation_index integer;
alter table deal_blasts add column if not exists variation_title text default '';

alter table deal_leads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_leads'
      and policyname = 'authenticated_full_access_deal_leads'
  ) then
    execute 'create policy "authenticated_full_access_deal_leads" on deal_leads
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;

-- Keep updated_at current on stage/notes edits
create or replace function set_deal_leads_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_deal_leads_updated_at on deal_leads;
create trigger trg_deal_leads_updated_at
  before update on deal_leads
  for each row execute function set_deal_leads_updated_at();
