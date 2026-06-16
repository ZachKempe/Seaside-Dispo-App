-- R3 — per-recipient blast logging (who got it / who failed, retry just failures)
-- D1 — email opt-out for unsubscribe compliance.

create table if not exists blast_recipients (
  id              bigint generated always as identity primary key,
  card_id         text not null,
  buyer_id        bigint references buyers(id) on delete set null,
  address         text default '',
  channel         text not null,            -- email | sms
  recipient       text default '',          -- the email/phone actually used
  status          text not null default 'sent',  -- sent | failed
  detail          text default '',
  variation_index integer,
  variation_title text default '',
  blasted_at      timestamptz default now()
);

create index if not exists idx_blast_recipients_card  on blast_recipients(card_id, channel, status);
create index if not exists idx_blast_recipients_buyer on blast_recipients(buyer_id);

-- D1: let buyers opt out of email without deactivating them entirely.
alter table buyers add column if not exists email_opt_out boolean default false;

alter table blast_recipients enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'blast_recipients'
      and policyname = 'authenticated_full_access_blast_recipients'
  ) then
    execute 'create policy "authenticated_full_access_blast_recipients" on blast_recipients
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
