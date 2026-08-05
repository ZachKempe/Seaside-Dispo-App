-- 034: Sub-To rent optionality + HOA (spec: "Sub-To Deck: Rent Optionality, HOA").
-- The sub-to deck page states what a deal COSTS (entry fee, PITI) and never what
-- it RETURNS. These columns are what let it show the rent strategies that
-- actually work at a property — and, just as importantly, the ones the HOA or
-- the municipality forbids.
--
-- (The build spec called this file 021; 021 was already taken by
-- 021_dispo_stage_and_notes.sql, and this repo's migrations live in sql/ and are
-- run by hand in the Supabase SQL editor. Numbered 034 as the next free slot.)
--
-- Purely additive and idempotent: every column is nullable with NO default.
-- Null is the signal for "not applicable / not entered" and it drives every
-- render gate in the code — `default 0` would make an un-entered rent look like
-- a real $0 rent, and an un-entered HOA indistinguishable from "no HOA".
-- Until this runs, the deck page and the terms editor simply behave as they do
-- today (every new field reads undefined, every gate defaults to hidden).

-- HOA dues and the CC&R rules that gate rental strategy.
alter table deal_terms add column if not exists hoa_monthly int;
-- none | allowed | min_term | capped | prohibited
alter table deal_terms add column if not exists hoa_rental_policy text;
alter table deal_terms add column if not exists hoa_min_lease_days int;

-- Rent by strategy. A rent without its source never renders on the deck, so
-- the *_source columns are load-bearing, not annotations.
alter table deal_terms add column if not exists rent_ltr int;
alter table deal_terms add column if not exists rent_mtr int;
alter table deal_terms add column if not exists rent_str int;
alter table deal_terms add column if not exists rent_ltr_source text;
alter table deal_terms add column if not exists rent_mtr_source text;
alter table deal_terms add column if not exists rent_str_source text;
-- ltr | mtr | str — which strategy the blast email/SMS teases.
alter table deal_terms add column if not exists primary_rent_mode text;

-- allowed | permit_required | restricted | unknown.
-- Null and 'unknown' both block the short-term column: an STR figure must
-- never render on a property whose STR status nobody confirmed.
alter table deal_terms add column if not exists str_permitted text;
alter table deal_terms add column if not exists str_furnishing_cost int;
alter table deal_terms add column if not exists mtr_furnishing_cost int;

-- Principal + interest portion of PITI — enables the principal-paydown line.
alter table deal_terms add column if not exists loan_pi int;
alter table deal_terms add column if not exists est_closing_costs int;
alter table deal_terms add column if not exists market_value int;

insert into schema_migrations (filename) values ('034_subto_rent_and_hoa.sql')
on conflict do nothing;
