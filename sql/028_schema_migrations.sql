-- 028 — Migration ledger.
-- Records which sql/ files have been applied, so "did I run 026?" is a query
-- instead of memory. Seeds every migration up to and including this one
-- (running this file implies the prior ones were applied).
--
-- Convention from here on: every NEW migration ends with
--   insert into schema_migrations (filename) values ('0XX_name.sql')
--   on conflict do nothing;

create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz default now()
);

alter table schema_migrations enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schema_migrations'
      and policyname = 'authenticated_read_schema_migrations'
  ) then
    execute 'create policy "authenticated_read_schema_migrations" on schema_migrations
               for select using (auth.role() = ''authenticated'')';
  end if;
end $$;

insert into schema_migrations (filename) values
  ('001_init_schema.sql'),
  ('002_allow_explicit_ids.sql'),
  ('003_fix_sequences.sql'),
  ('004_pipeline_and_analytics.sql'),
  ('005_deal_acquisition.sql'),
  ('006_morby_deals.sql'),
  ('007_morby_interest_type.sql'),
  ('008_inbound_capture.sql'),
  ('009_blast_recipients.sql'),
  ('010_cover_image.sql'),
  ('011_property_photos_bucket.sql'),
  ('012_morby_address_override.sql'),
  ('013_buyer_onboarding.sql'),
  ('014_leads.sql'),
  ('015_il_property_id.sql'),
  ('016_leads_engagement.sql'),
  ('017_properties_archived.sql'),
  ('018_morby_additional_broker.sql'),
  ('019_drop_leads.sql'),
  ('020_deck_pages.sql'),
  ('021_dispo_stage_and_notes.sql'),
  ('022_dispo_stages_table.sql'),
  ('023_deck_view_kinds.sql'),
  ('024_buyer_buybox_fields.sql'),
  ('025_sync_runs.sql'),
  ('026_email_events.sql'),
  ('027_deal_tasks.sql'),
  ('028_schema_migrations.sql')
on conflict do nothing;
