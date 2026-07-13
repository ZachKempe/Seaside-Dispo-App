-- Seaside Dispo — Property-level dispo stage + shared deal notes feed
--
-- Purely additive. Safe to run against production (IF NOT EXISTS throughout).
--
-- 1) properties gains a manual dispo_stage the operator + partners move by hand,
--    plus who/when stamping so a shared board has an accountability + aging clock.
--    Default 'prep' backfills every existing row → "everything lands in Prep".
--
-- 2) deal_notes: an append-only, authored, timestamped notes feed per deal.
--    Replaces the single overwriteable property_status.notes blob for the
--    partner-facing use case (last-write-wins clobbering is unacceptable when
--    more than one person edits). property_status is left untouched.

-- ── 1) dispo stage on properties ─────────────────────────────────────────────
alter table properties add column if not exists dispo_stage    text        default 'prep';
alter table properties add column if not exists stage_moved_at timestamptz;
alter table properties add column if not exists stage_moved_by text        default '';

-- Optional: makes stale-deal filtering fast if you later query by stage.
create index if not exists idx_properties_dispo_stage on properties(dispo_stage);

-- ── 2) append-only deal notes ────────────────────────────────────────────────
create table if not exists deal_notes (
    id           bigint generated always as identity primary key,
    card_id      text not null,
    body         text not null,
    author_email text default '',
    created_at   timestamptz default now()
);

create index if not exists idx_deal_notes_card_id on deal_notes(card_id);

alter table deal_notes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_notes'
      and policyname = 'authenticated_full_access_deal_notes'
  ) then
    execute 'create policy "authenticated_full_access_deal_notes" on deal_notes
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
