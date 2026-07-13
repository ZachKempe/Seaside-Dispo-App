-- Seaside Dispo — customizable pipeline stages
--
-- Moves the dispo stage list out of hardcoded JS into a table the operator can
-- edit from the Pipeline "Manage stages" modal (rename, recolor, reorder, add,
-- delete). `properties.dispo_stage` stores a stage `key`; keys are stable and
-- never change on rename, so existing deals keep their column. Deleting a stage
-- reassigns its deals to the first stage (handled in the app, not here).
--
-- Purely additive. Seeds the six original stages so nothing changes visually
-- until the operator edits them. Safe to run against production.

create table if not exists dispo_stages (
    key         text primary key,
    label       text not null,
    color       text not null default '#A0AEC0',
    position    int  not null default 0,
    is_terminal boolean not null default false,   -- final stage: no stale flag, no shoulder-tap
    created_at  timestamptz default now()
);

-- Seed defaults (idempotent — only fills keys that don't exist yet).
insert into dispo_stages (key, label, color, position, is_terminal) values
    ('prep',      'Prep / Not Live',  '#A0AEC0', 0, false),
    ('live',      'Live / Marketing', '#3182CE', 1, false),
    ('interest',  'Interest',         '#6B46C1', 2, false),
    ('committed', 'Committed',        '#DD6B20', 3, false),
    ('closed',    'Closed 🎉',        '#2F855A', 4, true),
    ('dead',      'Dead',             '#C53030', 5, true)
on conflict (key) do nothing;

alter table dispo_stages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'dispo_stages'
      and policyname = 'authenticated_full_access_dispo_stages'
  ) then
    execute 'create policy "authenticated_full_access_dispo_stages" on dispo_stages
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
