-- 033: buy-box onboarding sequence (B4.2 / finding H12).
-- onboard-buyers.js used to send exactly one email ever — onboarded_at was
-- the whole state machine, so anyone who ignored the first ask stayed a
-- wildcard (matching every deal) forever. These columns track the short
-- follow-up sequence: which touch a buyer has had, when, and on what channel.
--
-- Until this runs the function fails soft to the old one-email behavior; it
-- probes for onboard_touches and, not finding it, refuses to send follow-ups
-- it would be unable to record.
alter table buyers add column if not exists onboard_touches int not null default 0;
alter table buyers add column if not exists onboard_last_at timestamptz;
alter table buyers add column if not exists onboard_last_channel text;

-- Backfill: everyone already asked has had exactly one touch, at the time
-- stamped in onboarded_at. Guarded on onboard_touches = 0 so re-running this
-- file can't inflate anyone's count.
update buyers
   set onboard_touches = 1,
       onboard_last_at = coalesce(onboard_last_at, onboarded_at),
       onboard_last_channel = coalesce(onboard_last_channel, 'email')
 where onboarded_at is not null
   and onboard_touches = 0;

insert into schema_migrations (filename) values ('033_onboard_sequence.sql')
on conflict do nothing;
