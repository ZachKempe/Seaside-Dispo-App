-- 023 — Distinguish deck page views from PDF downloads.
-- The /deck/<slug> page shows a real-data activity strip ("N views in the last
-- 24 hours · N PDF downloads"). Page views keep the default kind='view';
-- the /deck/<slug>.pdf redirect logs kind='pdf'. Existing rows backfill to 'view'.

alter table deck_views add column if not exists kind text not null default 'view';

create index if not exists idx_deck_views_card_kind_time
  on deck_views (card_id, kind, viewed_at);
