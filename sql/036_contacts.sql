-- 036 — Contacts: the non-buyer side of the network.
--
-- Buyers stay in `buyers` and NOTHING here touches them. That separation is
-- deliberate and load-bearing: DealShared.matchesDeal treats anyone with no
-- state / strategy / money cap as a WILDCARD and passes them on every deal, so
-- a DSCR lender filed as a buyer would silently receive every blast. Keeping
-- lenders, brokers and agents in their own table makes that impossible —
-- send-blast.js, onboard-buyers.js and the matcher never read this table.
--
-- Pure contact list: who they are, how to reach them, what markets they cover,
-- and free-text notes. No buy box, no matching, no sending.

create table if not exists contacts (
  id           bigint generated always as identity primary key,
  contact_type text not null,              -- dscr_lender | mortgage_broker | transactional_lender | vip_agent
  name         text not null,
  company      text    default '',
  email        text    default '',
  phone        text    default '',
  states       text    default '',         -- comma-separated markets, e.g. "FL,TX,MN"
  notes        text    default '',
  source       text    default 'direct',
  active       boolean default true,       -- soft delete, same convention as buyers
  date_added   timestamptz default now()
);

create index if not exists idx_contacts_type on contacts (contact_type, active);

-- Manual touch log. Mirrors buyer_activity, but can't reuse it: that table's
-- buyer_id is a FK onto buyers(id).
create table if not exists contact_activity (
  id         bigint generated always as identity primary key,
  contact_id bigint not null references contacts(id) on delete cascade,
  channel    text    not null default 'manual',   -- manual | note | call | email | sms
  detail     text    default '',
  created_at timestamptz default now()
);

create index if not exists idx_contact_activity_contact on contact_activity (contact_id, created_at desc);

alter table contacts enable row level security;
alter table contact_activity enable row level security;

drop policy if exists "authenticated_full_access_contacts" on contacts;
create policy "authenticated_full_access_contacts" on contacts
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "authenticated_full_access_contact_activity" on contact_activity;
create policy "authenticated_full_access_contact_activity" on contact_activity
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

insert into schema_migrations (filename) values ('036_contacts.sql')
on conflict do nothing;
