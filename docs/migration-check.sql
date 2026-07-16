-- migration-check.sql — paste into the Supabase SQL editor.
--
-- PART A ledger check: lists any numbered migration in sql/ not recorded in
-- schema_migrations. NOTE: migration 028 blindly seeds 001–028 as "applied"
-- when it runs, so the ledger CANNOT prove that 018/019/024 actually ran —
-- it only reliably tracks migrations added AFTER 028. Use Part B for those.

with expected(filename) as (values
    ('001_init_schema.sql')
  , ('002_allow_explicit_ids.sql')
  , ('003_fix_sequences.sql')
  , ('004_pipeline_and_analytics.sql')
  , ('005_deal_acquisition.sql')
  , ('006_morby_deals.sql')
  , ('007_morby_interest_type.sql')
  , ('008_inbound_capture.sql')
  , ('009_blast_recipients.sql')
  , ('010_cover_image.sql')
  , ('011_property_photos_bucket.sql')
  , ('012_morby_address_override.sql')
  , ('013_buyer_onboarding.sql')
  , ('014_leads.sql')
  , ('015_il_property_id.sql')
  , ('016_leads_engagement.sql')
  , ('017_properties_archived.sql')
  , ('018_morby_additional_broker.sql')
  , ('019_drop_leads.sql')
  , ('020_deck_pages.sql')
  , ('021_dispo_stage_and_notes.sql')
  , ('022_dispo_stages_table.sql')
  , ('023_deck_view_kinds.sql')
  , ('024_buyer_buybox_fields.sql')
  , ('025_sync_runs.sql')
  , ('026_email_events.sql')
  , ('027_deal_tasks.sql')
  , ('028_schema_migrations.sql')
)
select e.filename as missing_from_ledger
from expected e
left join schema_migrations m on m.filename = e.filename
where m.filename is null
order by e.filename;

-- PART B — truth check for the three the automation-repo notes flagged as
-- "pending to verify" (018, 019, 024). Reads the actual schema, so it's correct
-- even though the ledger claims they're applied. Want all three = true.
select
  -- 018: additional_broker_pct column on morby_deals
  (to_regclass('public.morby_deals') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='morby_deals'
                   and column_name='additional_broker_pct'))          as migration_018_applied,
  -- 024: close_speed / status / asset_type columns on buyers
  (exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='buyers' and column_name='close_speed')
   and exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='buyers' and column_name='asset_type')) as migration_024_applied,
  -- 019: the legacy `leads` table was DROPPED (true = drop happened)
  (to_regclass('public.leads') is null)                                as migration_019_applied;
