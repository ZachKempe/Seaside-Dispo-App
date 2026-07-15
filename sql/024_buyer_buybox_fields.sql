-- 024: Structured buy-box fields on buyers.
-- Backs the master–detail Buyer Dashboard (deal matcher). Previously
-- close speed / status / asset type lived as free text inside notes;
-- the dashboard still parses notes as a fallback until this is run.
alter table buyers add column if not exists close_speed text default '';  -- e.g. 'Fast (≤7d)' | 'Medium (14–30d)' | 'Slow (30d+)'
alter table buyers add column if not exists status      text default '';  -- e.g. 'Ready now'
alter table buyers add column if not exists asset_type  text default '';  -- e.g. 'SFR' | 'STR' | 'Small multi'
