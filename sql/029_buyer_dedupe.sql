-- 029_buyer_dedupe.sql — F7: database-level buyer uniqueness.
--
-- Three intake paths write buyers (submit-buyer.js on the buyer-form site,
-- the sync-buyers poll, and inbound-reply capture), each deduping in code
-- with historically different normalization. Format-sensitive dedupe means
-- duplicate buyers, split engagement history, and double-texting one person.
-- This migration makes the database the last line of defense:
--   1. buyers.phone_norm — generated digits-only phone, matching digitsOnly()
--      in the functions (strip non-digits, then one leading "1")
--   2. lowercase existing emails in place (every current write path already
--      lowercases; this catches old CSV-imported rows)
--   3. deactivate existing duplicates — soft and reversible, keeps the OLDEST
--      row of each group active (oldest ids are what historical
--      blast_recipients / engagement rows point at); nothing is deleted
--   4. partial unique indexes over ACTIVE buyers (so the deactivated dupes
--      from step 3 can coexist, and a former buyer's number can re-enter
--      through intake without tripping the constraint)
--
-- To preview what step 3 will touch, run these first:
--   select phone_norm, array_agg(id order by id) as ids, count(*)
--     from buyers where active and phone_norm <> ''
--     group by phone_norm having count(*) > 1;
--   select lower(email), array_agg(id order by id) as ids, count(*)
--     from buyers where active and coalesce(email, '') <> ''
--     group by lower(email) having count(*) > 1;
-- (Step 3 only flips `active` and appends a "[dedupe 029]" note, so any row
-- it touches can be restored by hand afterwards.)

-- 1. Generated normalized-phone column.
alter table buyers add column if not exists phone_norm text
  generated always as (
    regexp_replace(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '^1', '')
  ) stored;

-- 2. Normalize stored emails so exact-match lookups (email=eq.<lowercase>)
-- hit rows imported before the write paths lowercased consistently.
update buyers set email = lower(email)
  where email is not null and email <> lower(email);

-- 3a. Deactivate later phone duplicates (idempotent: reruns see the earlier
-- losers as inactive and match nothing).
with ranked as (
  select id, row_number() over (partition by phone_norm order by id) as rn
    from buyers where active and phone_norm <> ''
)
update buyers b
   set active = false,
       notes = trim(both ' | ' from coalesce(b.notes, '') || ' | [dedupe 029] deactivated: duplicate phone')
  from ranked r
 where b.id = r.id and r.rn > 1;

-- 3b. Deactivate later email duplicates among whoever is still active.
with ranked as (
  select id, row_number() over (partition by lower(email) order by id) as rn
    from buyers where active and coalesce(email, '') <> ''
)
update buyers b
   set active = false,
       notes = trim(both ' | ' from coalesce(b.notes, '') || ' | [dedupe 029] deactivated: duplicate email')
  from ranked r
 where b.id = r.id and r.rn > 1;

-- 4. Unique indexes. Partial on `active` so soft-deleted rows never block an
-- insert, and partial on non-empty so blank contact info stays allowed.
create unique index if not exists buyers_phone_norm_unique
  on buyers (phone_norm) where phone_norm <> '' and active;
create unique index if not exists buyers_email_lower_unique
  on buyers (lower(email)) where coalesce(email, '') <> '' and active;

insert into schema_migrations (filename) values ('029_buyer_dedupe.sql')
  on conflict do nothing;
