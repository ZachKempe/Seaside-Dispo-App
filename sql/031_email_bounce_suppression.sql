-- 031: hard-bounce suppression (C4).
-- resend-events.js stamps email_bounced_at when Resend reports a permanent
-- bounce; blast-core and the dashboard blast preview skip any buyer with it
-- set. Until this runs, both fail soft (the column just reads as absent).
alter table buyers add column if not exists email_bounced_at timestamptz;

insert into schema_migrations (filename) values ('031_email_bounce_suppression.sql')
on conflict do nothing;
