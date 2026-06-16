-- Morby Method deals: seller-finance / deferred-interest deal structure.
-- Adds a deal_type split (sub-to vs morby) to properties, and a dedicated
-- table holding the LOI terms + Deal Deck inputs for morby deals.

-- Classify each deal as "subto" (existing flow) or "morby" (new flow).
alter table properties add column if not exists deal_type text not null default 'subto';
alter table properties drop constraint if exists properties_deal_type_check;
alter table properties add constraint properties_deal_type_check
  check (deal_type in ('subto', 'morby'));

create table if not exists morby_deals (
  card_id text primary key references properties(card_id) on delete cascade,

  -- Property type drives which Deal Deck template + DSCR defaults are used.
  property_type text not null default 'single_family'
    check (property_type in ('single_family', 'commercial')),

  -- LOI / Financial Terms
  purchase_price numeric,
  down_payment numeric,
  earnest_money_amount numeric,
  closing_costs_note text default 'Buyer pays all closing costs',
  broker_commission text default 'None',

  -- Seller Financing (deferred interest / balloon)
  seller_carry_balance numeric,
  deferred_interest_rate numeric,
  monthly_payment numeric default 0,
  balloon_months integer,

  -- Timeline & Contingencies
  inspection_period_days integer default 15,
  close_of_escrow_days integer default 30,
  financing_contingency boolean default true,

  -- Property Details
  tenancy_description text,
  property_description text,

  -- Income & Expense Projections
  ltr_monthly_rent numeric,          -- single_family: Long-Term Rent
  str_monthly_rent numeric,          -- single_family: Short-Term Rent
  annual_noi numeric,                -- commercial
  monthly_noi numeric,               -- commercial

  -- DSCR debt-service assumptions (defaults applied client-side based on
  -- property_type: single_family = 7.75% / 75% LTV / 800, commercial = 8.5% / 70% LTV / 800)
  dscr_rate numeric,
  dscr_ltv numeric,
  dscr_credit_score integer default 800,

  -- Misc seller flexibility notes (e.g. "Seller willing to finance $X after balloon...")
  seller_flexibility_notes text,

  updated_at timestamptz default now()
);

create index if not exists idx_morby_deals_card_id on morby_deals(card_id);

alter table morby_deals enable row level security;

drop policy if exists "authenticated_full_access_morby_deals" on morby_deals;
create policy "authenticated_full_access_morby_deals" on morby_deals
  for all using (auth.role() = 'authenticated');
