-- 035: the third deal structure — "cash".
--
-- A cash deal is a wholesale purchase priced off a SELLER CONCESSION: the
-- seller's original price less the amount they agree to forgive is what the
-- buyer actually pays. The buyer closes with cash (usually a DSCR loan behind
-- it) — there is no existing loan taken subject-to and no seller carryback.
--
-- Structurally it is the Morby deck MINUS seller financing:
--   deleted   — seller carry balance, deferred rate, monthly payment during
--               deferral, balloon, balloon payoff, seller flexibility notes
--   kept      — LOI terms, timeline/contingencies, DSCR loan, LTR/STR net
--               cash flow, property details
--   new       — the three-number price stack (original → forgiven → purchase)
--
-- Deliberately NO cash-at-close column or math. On a Morby deal the DSCR loan
-- proceeds exceed the buyer's cash in, which produces a payday at the table
-- that gets split; on a cash deal the buyer funds the purchase and the
-- FORGIVEN AMOUNT is the whole headline. Reusing buyerCashAtClose here would
-- print a number that does not exist.
--
-- Additive and idempotent, like every migration in this folder. Until it runs,
-- nothing changes: no card can have deal_type 'cash', so every existing
-- subto/morby branch behaves exactly as it does today.

-- ── properties.deal_type gains a third value ──────────────────────────────
-- 006 created this constraint as ('subto','morby'). Dropping and re-adding is
-- the same shape 006 used, so re-running either file is safe.
alter table properties drop constraint if exists properties_deal_type_check;
alter table properties add constraint properties_deal_type_check
  check (deal_type in ('subto', 'morby', 'cash'));

-- ── cash_deals ────────────────────────────────────────────────────────────
-- Mirrors morby_deals (own table per structure) rather than overloading
-- deal_terms, which is the Sub-To term sheet and carries an existing loan,
-- PITI and the 034 rent/HOA columns that a cash deal has no use for.
create table if not exists cash_deals (
  card_id text primary key references properties(card_id) on delete cascade,

  -- Drives the DSCR defaults and which cash-flow template the deck uses,
  -- exactly as on morby_deals.
  property_type text not null default 'single_family'
    check (property_type in ('single_family', 'commercial')),

  -- Deck address, without renaming the card. Same role as
  -- morby_deals.address_override (migration 012).
  address_override text default '',

  -- ── The price stack ────────────────────────────────────────────────────
  -- original_price − amount_forgiven = purchase_price.
  --
  -- All three are stored and all three are nullable: a deal is routinely
  -- entered (or extracted from a contract) knowing only two of them.
  -- cashPriceStack() in deal-shared.js derives whichever is missing, so a
  -- partially-filled deal still renders a complete, self-consistent stack.
  original_price numeric,   -- what the seller was asking / owed before the concession
  amount_forgiven numeric,  -- the concession — THE headline number on this deck
  purchase_price numeric,   -- what the buyer actually funds at closing

  -- Optional deposit line. Data-gated everywhere: a cash deal entered without
  -- it renders the clean three-number stack and nothing else.
  down_payment numeric,

  earnest_money_amount numeric,
  closing_costs_note text default 'Buyer pays all closing costs',
  broker_commission text default 'None',
  -- % of purchase price. Unlike Morby it feeds no cash-at-close figure (there
  -- isn't one) — it is disclosed on the deck as a transaction cost.
  additional_broker_pct numeric default 0,

  -- Timeline & contingencies
  inspection_period_days integer default 15,
  close_of_escrow_days integer default 30,
  financing_contingency boolean default true,

  -- Property details
  tenancy_description text,
  property_description text,

  -- Income & expenses (single_family uses ltr/str, commercial uses NOI)
  ltr_monthly_rent numeric,
  str_monthly_rent numeric,
  annual_noi numeric,
  monthly_noi numeric,
  monthly_taxes numeric,
  monthly_insurance numeric,

  -- DSCR debt-service assumptions. Defaults are applied client-side by
  -- property type (single_family 7.75% / 75% LTV / 800, commercial
  -- 8.5% / 70% LTV / 800), same as the Morby panel.
  dscr_rate numeric,
  dscr_ltv numeric,
  dscr_credit_score integer default 800,

  updated_at timestamptz default now()
);

create index if not exists idx_cash_deals_card_id on cash_deals(card_id);

alter table cash_deals enable row level security;

drop policy if exists "authenticated_full_access_cash_deals" on cash_deals;
create policy "authenticated_full_access_cash_deals" on cash_deals
  for all using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

insert into schema_migrations (filename) values ('035_cash_deals.sql')
on conflict do nothing;
