-- 027 — Per-deal tasks / reminders ("next action + due date").
-- Shown on the Pipeline board: card faces carry the next open task, the header
-- rolls up overdue count, and the detail modal manages the checklist. Stale
-- flags catch neglect after the fact; tasks schedule attention before it.

create table if not exists deal_tasks (
  id         bigint generated always as identity primary key,
  card_id    text not null,
  title      text not null,
  due_date   date,                      -- optional; overdue = past due + not done
  done       boolean default false,
  done_at    timestamptz,
  created_by text default '',
  created_at timestamptz default now()
);

create index if not exists idx_deal_tasks_card on deal_tasks (card_id, done, due_date);

alter table deal_tasks enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_tasks'
      and policyname = 'authenticated_full_access_deal_tasks'
  ) then
    execute 'create policy "authenticated_full_access_deal_tasks" on deal_tasks
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
