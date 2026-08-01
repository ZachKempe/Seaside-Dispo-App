-- 032: durable SMS opt-out suppression.
-- ghl-inbound flips buyers.sms_opt_in when a STOP reply matches a buyer row,
-- but a number with no matching buyer (unknown, or stored in a format the
-- digit-match can't reconcile) previously left no record anywhere — it could
-- be texted again later. Every opt-out now also lands here, keyed by
-- normalized digits (non-digits stripped, leading US "1" dropped — the
-- digitsOnly() convention), and blast-core's SMS audience filter consults it.
-- Both sides fail soft (warn-and-continue / empty set) until this runs.
create table if not exists sms_suppressions (
  phone_digits text primary key,           -- digitsOnly()-normalized number
  raw_phone    text not null default '',   -- as received, for auditing
  reason       text not null default 'stop_reply',
  created_at   timestamptz not null default now()
);

alter table sms_suppressions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sms_suppressions'
      and policyname = 'authenticated_full_access_sms_suppressions'
  ) then
    execute 'create policy "authenticated_full_access_sms_suppressions" on sms_suppressions
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;

insert into schema_migrations (filename) values ('032_sms_suppressions.sql')
on conflict do nothing;
