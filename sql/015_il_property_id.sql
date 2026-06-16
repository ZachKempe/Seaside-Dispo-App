-- Link each posting-dashboard deal to its InvestorLift property ID.
-- Once set, the daily scraper pulls Artemis hot buyers for that deal only.
-- Cleared when the deal is removed from the dashboard = scraper stops automatically.
alter table properties add column if not exists il_property_id text default null;
create index if not exists properties_il_id_idx on properties (il_property_id) where il_property_id is not null;
