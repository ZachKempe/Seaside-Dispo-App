-- 038 — buyers.property_types: which property types a buyer wants.
--
-- A comma list of keys, same shape as buyers.strategy:
--   sfh, multifamily, hospitality, commercial, retail, other
-- Empty = no preference (any type). Set by clicking the pills on a buyer's
-- card on buyers.html, or the checkboxes in Add/Edit Buyer.
--
-- Buyers-page only: it drives the list filter and the "Match a deal" score.
-- It is deliberately NOT read by matchesDeal, so it never changes who
-- receives a blast. Deals themselves keep the two-value property_type on
-- morby_deals / cash_deals (single_family / commercial), which drives loan math.
--
-- Backfill: the public buyer form has always asked "property types" (SFH,
-- Commercial, RV Park, Hotel, Other) but sync-buyers only wrote the answer
-- into notes as "Property types: SFH, Hotel". Parse that into the column.
-- RV Park and Hotel both become hospitality. Only fills blank rows, so
-- re-running never overwrites a type set by hand.

alter table buyers add column if not exists property_types text default '';

update buyers b set property_types = sub.keys
from (
  select id, array_to_string(array(
    select k from unnest(array['sfh','multifamily','hospitality','commercial','retail','other']) with ordinality as t(k, ord)
    where (k = 'sfh'         and raw ~* '\m(sfh|sfr|single)')
       or (k = 'multifamily' and raw ~* 'multi')
       or (k = 'hospitality' and raw ~* '(hotel|motel|rv park|hospitality)')
       or (k = 'commercial'  and raw ~* 'commercial')
       or (k = 'retail'      and raw ~* 'retail')
       or (k = 'other'       and raw ~* '\mother\M')
    order by ord
  ), ',') as keys
  from (
    select id, (regexp_match(notes, 'Property types:\s*([^|\n]+)', 'i'))[1] as raw
    from buyers
    where coalesce(property_types, '') = '' and notes ~* 'Property types:'
  ) parsed
  where raw is not null
) sub
where b.id = sub.id and sub.keys <> '';

insert into schema_migrations (filename) values ('038_buyer_property_types.sql')
on conflict do nothing;
