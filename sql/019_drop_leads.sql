-- Retire the InvestorLift scraped-lead staging. The scrape is turned off and
-- the Leads page is removed, so this table and its engagement columns are no
-- longer used. The per-deal response pipeline (deal_leads) is separate and is
-- intentionally kept.
--
-- WARNING: this permanently deletes all rows in `leads`. Irreversible.
drop table if exists leads cascade;

-- The InvestorLift property-id link on properties is no longer read anywhere.
-- Safe to drop; harmless to leave. Uncomment to remove it too.
-- alter table properties drop column if exists il_property_id;
