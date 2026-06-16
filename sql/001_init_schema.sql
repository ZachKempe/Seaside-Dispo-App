-- Seaside Dispo — Supabase schema
-- Mirrors the existing buyers.db SQLite schema, translated to Postgres.

create table if not exists buyers (
    id          bigint generated always as identity primary key,
    name        text    not null,
    email       text    default '',
    phone       text    default '',
    strategy    text    default 'all',     -- subto | owner_finance | cash | morby | all
    states      text    default '',        -- comma-separated e.g. "FL,TX,MN"
    max_price   integer default 0,
    max_piti    integer default 0,
    min_beds    integer default 0,
    tier        text    default 'B',       -- A (hot) | B (warm) | C (cold)
    list_source text    default '',        -- jv | owners_club | direct | investor | import
    active      boolean default true,
    sms_opt_in  boolean default false,
    notes       text    default '',
    date_added  timestamptz default now()
);

create table if not exists deal_blasts (
    id          bigint generated always as identity primary key,
    card_id     text    not null,
    address     text    not null,
    channel     text    not null,          -- email | sms | investorlift | creativelisting | fb_group | fb_marketplace
    status      text    default 'pending', -- pending | sent | failed | skipped
    detail      text    default '',
    blasted_at  timestamptz default now()
);

create table if not exists facebook_posts (
    id          bigint generated always as identity primary key,
    card_id     text    not null,
    card_name   text    not null default '',
    group_name  text    not null,
    posted_at   timestamptz default now()
);

create table if not exists buyer_activity (
    id          bigint generated always as identity primary key,
    buyer_id    bigint not null references buyers(id) on delete cascade,
    card_id     text    default '',
    address     text    default '',
    channel     text    not null,          -- email | sms | manual | note
    detail      text    default '',
    created_at  timestamptz default now()
);

create table if not exists property_status (
    card_id     text primary key,
    status      text not null default 'active',
    notes       text default '',
    updated_at  timestamptz default now()
);

create table if not exists deal_terms (
    card_id     text primary key,
    entry_fee   integer default 0,
    price       integer default 0,
    mortgage    integer default 0,
    rate        text    default '',
    piti        integer default 0,
    beds        integer default 0,
    baths       text    default '',
    sqft        integer default 0,
    year_built  integer default 0,
    updated_at  timestamptz default now()
);

-- Cache of Trello "Under Contract" cards so the dashboard can read instantly
-- without hitting the Trello API on every page load. Refreshed by the
-- scheduled sync job.
create table if not exists properties (
    card_id       text primary key,
    name          text not null,
    trello_url    text default '',
    state         text default '',
    agent         text default '',
    drive_link    text default '',
    fb_photos     jsonb default '[]',      -- [{ "url": "...", "name": "..." }]
    variations    jsonb default '[]',      -- [{ "title": "...", "body": "..." }]
    raw_comments  jsonb default '[]',
    synced_at     timestamptz default now()
);

create index if not exists idx_buyer_activity_buyer_id on buyer_activity(buyer_id);
create index if not exists idx_deal_blasts_card_id on deal_blasts(card_id);
create index if not exists idx_facebook_posts_card_id on facebook_posts(card_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Lock every table down so only an authenticated user (you) can read/write.
-- The Netlify Functions use the service_role key (bypasses RLS) for sync jobs;
-- the front-end uses the anon key + your logged-in session, gated by these policies.

alter table buyers           enable row level security;
alter table deal_blasts      enable row level security;
alter table facebook_posts   enable row level security;
alter table buyer_activity   enable row level security;
alter table property_status  enable row level security;
alter table deal_terms       enable row level security;
alter table properties       enable row level security;

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'buyers','deal_blasts','facebook_posts','buyer_activity',
    'property_status','deal_terms','properties'
  ])
  loop
    execute format(
      'create policy "authenticated_full_access_%1$s" on %1$I
         for all using (auth.role() = ''authenticated'')
         with check (auth.role() = ''authenticated'')', t
    );
  end loop;
end $$;
