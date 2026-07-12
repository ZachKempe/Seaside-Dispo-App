-- 020 — Interactive Deal Deck pages.
-- Adds a stable per-property slug for the branded /deck/<slug> page URL, and a
-- deck_views engagement log (who opened a deal page, when). Interest itself is
-- captured into the existing deal_leads table with source='deck_page' — no new
-- table is needed for that.

-- Stable slug for the branded page URL. Populated lazily by send-blast.js the
-- first time a deal is blasted, using the same deckSlug() value already used for
-- the PDF filename, so the page and the PDF share one slug.
alter table properties add column if not exists deck_slug text;
create unique index if not exists properties_deck_slug_uniq
  on properties (deck_slug) where deck_slug is not null;

-- One row per page view. buyer_id null = anonymous / untokenized (forwarded link).
create table if not exists deck_views (
  id            bigint generated always as identity primary key,
  card_id       text   not null,
  buyer_id      bigint references buyers(id) on delete set null,
  viewed_at     timestamptz default now(),
  dwell_seconds integer,          -- reserved for v2; nullable for now
  user_agent    text default ''
);
create index if not exists idx_deck_views_card  on deck_views (card_id);
create index if not exists idx_deck_views_buyer on deck_views (buyer_id);

alter table deck_views enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deck_views'
      and policyname = 'authenticated_full_access_deck_views'
  ) then
    execute 'create policy "authenticated_full_access_deck_views" on deck_views
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
