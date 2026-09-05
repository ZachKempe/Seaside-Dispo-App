-- 037 — buyer_messages: the saved copy of every text and email exchanged with
-- a buyer, behind the conversation panel on buyers.html (buyer-messages.js).
--
-- The panel first shipped reading GoHighLevel and Gmail live on every open.
-- Gmail's per-minute quota for the mailbox killed that within the hour: a
-- handful of opens plus the auto-refresh was enough for a 403 and an empty
-- thread. This table is what makes the panel bulletproof —
--   • history renders from here instantly, even when a provider is down or
--     rate-limiting (the panel then says "saved history", not an error);
--   • provider syncs are INCREMENTAL: only messages not already here are
--     fetched, so a refresh costs Gmail one cheap list call instead of 40 gets;
--   • what we send from the dashboard is written here at send time, and the
--     inbound SMS webhook (ghl-inbound.js) writes here too, so the thread is
--     complete without waiting on a sync.
-- Rows are deduped on (provider, provider_id); the merge in
-- lib/conversation.js also folds a webhook copy and a synced copy of the same
-- text together when their ids differ.
--
-- Before this runs, buyer-messages.js falls back to live-only reads and the
-- panel names this file.

create table if not exists buyer_messages (
  id           bigint generated always as identity primary key,
  buyer_id     bigint not null references buyers(id) on delete cascade,
  channel      text   not null,               -- sms | email
  direction    text   not null,               -- in | out
  provider     text   not null default '',    -- ghl | gmail | resend | webhook
  provider_id  text   not null default '',    -- GHL message id / Gmail message id / Resend id
  thread_id    text   default '',             -- GHL conversation id / Gmail thread id
  message_id   text   default '',             -- RFC 2822 Message-ID (email), for In-Reply-To
  subject      text   default '',
  body         text   default '',
  status       text   default '',             -- delivered | sent | failed | ...
  from_addr    text   default '',
  sent_at      timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create unique index if not exists uq_buyer_messages_provider
  on buyer_messages (provider, provider_id) where provider_id <> '';
create index if not exists idx_buyer_messages_buyer_time
  on buyer_messages (buyer_id, sent_at);

alter table buyer_messages enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'buyer_messages'
      and policyname = 'authenticated_full_access_buyer_messages'
  ) then
    execute 'create policy "authenticated_full_access_buyer_messages" on buyer_messages
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;

insert into schema_migrations (filename) values ('037_buyer_messages.sql')
on conflict do nothing;
