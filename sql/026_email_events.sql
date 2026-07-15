-- 026 — Email engagement events (opens / clicks / bounces / complaints).
-- Written by netlify/functions/resend-events.js, the Resend webhook receiver.
-- send-blast.js tags every Resend email with buyer_id + card_id, so events
-- come back attributed to a (buyer, deal) pair. Powers the buyer engagement
-- score and the per-buyer activity timeline.
--
-- Setup (one-time, in the Resend dashboard → Webhooks):
--   endpoint: https://<site>/.netlify/functions/resend-events
--   events:   email.delivered, email.opened, email.clicked,
--             email.bounced, email.complained
--   then set the signing secret as RESEND_WEBHOOK_SECRET in Netlify env.

create table if not exists email_events (
  id         bigint generated always as identity primary key,
  event      text   not null,      -- delivered | opened | clicked | bounced | complained
  buyer_id   bigint references buyers(id) on delete set null,
  card_id    text   default '',
  email      text   default '',
  link_url   text   default '',    -- clicked only
  resend_id  text   default '',    -- Resend email id, for tracing
  created_at timestamptz default now()
);

create index if not exists idx_email_events_buyer on email_events (buyer_id, created_at desc);
create index if not exists idx_email_events_card  on email_events (card_id, event);

alter table email_events enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'email_events'
      and policyname = 'authenticated_full_access_email_events'
  ) then
    execute 'create policy "authenticated_full_access_email_events" on email_events
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
