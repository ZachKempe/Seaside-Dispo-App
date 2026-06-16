-- Acquisition / due-diligence data for each under-contract deal.
-- Powers the new "Deal Info" tab on the Posting Dashboard.
-- All fields nullable -- completeness is computed client-side from a subset
-- of "core" fields (see dashboard.html `ACQ_CORE_FIELDS`).

create table if not exists deal_acquisition (
  card_id text primary key references properties(card_id) on delete cascade,

  -- Section 1: Property & Condition
  hoa boolean,
  hoa_amount numeric,
  hoa_rental_restriction boolean,
  hoa_str_allowed boolean,
  hoa_age_restricted boolean,
  roof_age integer,
  roof_type text,                -- Shingle / Metal / Tile / Flat
  hvac_age integer,
  water_heater_age integer,
  condition text,                -- Excellent / Good / Fair / Needs Work
  known_issues text,
  repair_budget numeric,

  -- Section 2: Loan Details
  lender_name text,
  loan_type text,                -- Conventional / FHA / VA / USDA
  loan_rate numeric,
  loan_term_value integer,
  loan_term_unit text,           -- months / years
  loan_current boolean,
  months_behind integer,
  arrears_amount numeric,
  prepayment_penalty text,       -- Yes / No / Unknown

  -- Section 3: Media Checklist
  video_url text,
  photos_count integer,
  mortgage_statement_url text,
  hoa_docs_url text,
  hoa_docs_na boolean,
  inspection_report_url text,
  inspection_na boolean,

  -- Section 4: Seller & Occupancy
  seller_motivation text,
  timeline_to_close text,
  occupied boolean,
  monthly_rent numeric,
  lease_end_date date,
  tenant_paying_on_time boolean,
  months_vacant integer,
  open_liens boolean,
  liens_notes text,
  in_probate boolean,

  updated_at timestamptz default now()
);

create index if not exists idx_deal_acquisition_card_id on deal_acquisition(card_id);

alter table deal_acquisition enable row level security;

-- Only authenticated users (Zach) can read/write -- mirrors other tables.
drop policy if exists "authenticated_full_access_deal_acquisition" on deal_acquisition;
create policy "authenticated_full_access_deal_acquisition" on deal_acquisition
  for all using (auth.role() = 'authenticated');
