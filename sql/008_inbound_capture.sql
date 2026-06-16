-- C1 — Auto-capture responders.
-- Idempotency ledger for inbound messages (email replies, GHL SMS) so the
-- capture jobs never double-process the same message. The capture logic itself
-- writes to the existing buyers / buyer_activity / deal_leads tables.

create table if not exists inbound_messages (
  message_id  text primary key,        -- Gmail message id or GHL message id
  channel     text not null default '',-- email | sms
  captured_at timestamptz default now()
);

alter table inbound_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'inbound_messages'
      and policyname = 'authenticated_full_access_inbound_messages'
  ) then
    execute 'create policy "authenticated_full_access_inbound_messages" on inbound_messages
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
