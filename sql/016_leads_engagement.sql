-- Promote InvestorLift Artemis engagement metrics from the free-text `notes`
-- field into real columns, so the posting dashboard can FUSE them into the
-- buyer-match score (a buyer who actually viewed THIS deal on IL is the hottest
-- possible lead). Also adds a stable IL customer id for refresh-on-rescrape.
alter table leads add column if not exists customer_id    text    default '';  -- IL /customers/{id}
alter table leads add column if not exists images_viewed  integer;
alter table leads add column if not exists time_spent     text;               -- "4m 12s" as IL displays it
alter table leads add column if not exists action_score   integer;
alter table leads add column if not exists buyer_score    integer default 0;   -- IL "Total score"
alter table leads add column if not exists engagement_at  timestamptz;         -- last time metrics refreshed

-- One lead row per IL customer per deal. Lets the scraper UPSERT engagement on
-- every re-scrape (a buyer's image/time counts grow over time) instead of
-- skipping anyone already seen.
create unique index if not exists leads_customer_deal_uniq
  on leads (customer_id, deal_id) where customer_id <> '';

create index if not exists leads_deal_id_idx on leads (deal_id) where deal_id <> '';
