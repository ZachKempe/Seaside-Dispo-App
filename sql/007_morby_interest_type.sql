-- Distinguish "deferred interest" (compounds, full balance + all accrued
-- interest due at balloon) from "interest only" (no compounding growth —
-- balloon payoff equals the original carry balance) seller-financing
-- structures, so the Deal Deck can compute an accurate balloon payoff.

alter table morby_deals add column if not exists interest_type text default 'deferred'
  check (interest_type in ('deferred', 'interest_only'));
