-- Lets Zach confirm/correct the address used on a Morby Deal Deck without
-- touching the synced Trello card name (which drives everything else).
alter table morby_deals add column if not exists address_override text default '';
