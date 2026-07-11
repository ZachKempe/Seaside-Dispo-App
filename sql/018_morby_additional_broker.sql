-- An additional broker commission (as a % of purchase price) charged on some
-- Morby deals. It's a transaction cost that reduces the cash generated at close
-- — subtracted alongside closing costs before the buyer's split — so a higher
-- percentage lowers the "Cash at Close" figure on the Deal Deck and email.
alter table morby_deals add column if not exists additional_broker_pct numeric default 0;
