-- 030 — Record WHICH channel a deck view came from.
--
-- SMS deck links were always tokenized the same way email links are (blast-core
-- appends ?b=<token> to both), so SMS views have always been attributed to the
-- right buyer — there was just no way to tell them apart from email views once
-- they landed. Blast links now carry &s=<source> and deck.js stores it here.
--
-- Values: 'sms' | 'email' | 'dm' (a per-buyer link copied from the dashboard)
--         | '' (unknown — direct/forwarded/copied link, and every pre-030 row).
-- Deliberately a plain text column with a '' default so old rows stay valid and
-- a new source can be added without another migration.

alter table deck_views add column if not exists source text not null default '';

-- Powers the per-deal "views by channel" rollup and the per-buyer breakdown.
create index if not exists idx_deck_views_card_source
  on deck_views (card_id, source);

insert into schema_migrations (filename) values ('030_deck_view_source.sql')
on conflict do nothing;
