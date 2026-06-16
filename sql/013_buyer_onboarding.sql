-- Tracks the "what are you buying?" buy-box request so we only ask each buyer
-- once. Set when the onboarding blast goes out; their answers flow back in via
-- the buyer intake form -> sync-buyers.js, enriching states/price/strategy.
alter table buyers add column if not exists onboarded_at timestamptz;
