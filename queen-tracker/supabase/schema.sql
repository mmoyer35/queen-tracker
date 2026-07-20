-- ============================================================================
--  QUEEN TRACKER — Supabase schema
--  Run this ONCE in your Supabase project:  Dashboard -> SQL Editor -> New query
--  -> paste this whole file -> Run.
--
--  It creates:
--    * queens         (one row per queen bee)
--    * queen_photos   (many photos per queen)
--    * queen_events   (timeline: inspections / observations over time)
--    * Row Level Security so each logged-in user only sees their own data
--    * a private storage bucket "queen-photos" for uploaded pictures
-- ============================================================================

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
--  MAIN TABLE: queens
-- ---------------------------------------------------------------------------
create table if not exists public.queens (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,

  -- ---- Core rearing info ----
  queen_code        text not null,              -- your tag / label, e.g. "Q-2025-01"
  name              text,                        -- optional friendly name
  source_method     text,                        -- grafting / cell / walk-away split / swarm cell / purchased / other
  graft_date        date,
  emergence_date    date,                        -- when the cell emerged
  year              integer,                     -- rearing year (e.g. 2025)
  season            text,                        -- spring / summer / fall
  mother_queen_id   uuid references public.queens (id) on delete set null, -- lineage link
  drone_source      text,                        -- breeder colony / area the drones came from

  -- ---- Hive & performance ----
  current_hive      text,                        -- colony name / number she heads now
  mated_status      text,                        -- virgin / mated / laying / failed
  mating_date       date,
  laying_pattern    integer,                     -- 1-5
  brood_quality     integer,                     -- 1-5
  temperament       integer,                     -- 1-5 (5 = gentlest)
  honey_production  integer,                     -- 1-5
  productivity_notes text,

  -- ---- Genetics & traits ----
  race_line         text,                        -- Italian / Carniolan / Buckfast / Russian / Saskatraz / VSH / local / other
  marking_color     text,                        -- queen marking dot color (white/yellow/red/green/blue) or "unmarked"
  hygienic_behavior integer,                     -- 1-5
  mite_resistance   integer,                     -- 1-5
  notable_traits    text,

  -- ---- Status & lifecycle ----
  status            text default 'alive',        -- alive / dead / superseded / requeened / sold / lost / banked
  status_date       date,
  replaced_by_id    uuid references public.queens (id) on delete set null,
  notes             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists queens_user_idx        on public.queens (user_id);
create index if not exists queens_mother_idx       on public.queens (mother_queen_id);
create index if not exists queens_year_idx         on public.queens (year);

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists queens_set_updated_at on public.queens;
create trigger queens_set_updated_at
  before update on public.queens
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
--  PHOTOS: many per queen
-- ---------------------------------------------------------------------------
create table if not exists public.queen_photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  queen_id     uuid not null references public.queens (id) on delete cascade,
  storage_path text not null,                    -- path inside the "queen-photos" bucket
  caption      text,
  taken_on     date,
  is_primary   boolean default false,            -- show as the queen's main photo
  created_at   timestamptz not null default now()
);
create index if not exists queen_photos_queen_idx on public.queen_photos (queen_id);
create index if not exists queen_photos_user_idx  on public.queen_photos (user_id);

-- ---------------------------------------------------------------------------
--  EVENTS: a timeline of inspections / observations
-- ---------------------------------------------------------------------------
create table if not exists public.queen_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  queen_id     uuid not null references public.queens (id) on delete cascade,
  event_date   date not null,
  event_type   text,                             -- inspection / marked / caged / released / requeened / note / etc.
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists queen_events_queen_idx on public.queen_events (queen_id);
create index if not exists queen_events_user_idx  on public.queen_events (user_id);

-- ============================================================================
--  ROW LEVEL SECURITY  — every user sees only their own rows
-- ============================================================================
alter table public.queens        enable row level security;
alter table public.queen_photos  enable row level security;
alter table public.queen_events  enable row level security;

-- queens
drop policy if exists "own queens - select" on public.queens;
create policy "own queens - select" on public.queens
  for select using (auth.uid() = user_id);
drop policy if exists "own queens - insert" on public.queens;
create policy "own queens - insert" on public.queens
  for insert with check (auth.uid() = user_id);
drop policy if exists "own queens - update" on public.queens;
create policy "own queens - update" on public.queens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own queens - delete" on public.queens;
create policy "own queens - delete" on public.queens
  for delete using (auth.uid() = user_id);

-- queen_photos
drop policy if exists "own photos - all" on public.queen_photos;
create policy "own photos - all" on public.queen_photos
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- queen_events
drop policy if exists "own events - all" on public.queen_events;
create policy "own events - all" on public.queen_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
--  STORAGE  — private bucket for queen photos
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('queen-photos', 'queen-photos', false)
on conflict (id) do nothing;

-- Users can only touch files inside a folder named after their own user id:
--   queen-photos/<user_id>/<queen_id>/<filename>
drop policy if exists "queen photos - read own"   on storage.objects;
create policy "queen photos - read own" on storage.objects
  for select using (
    bucket_id = 'queen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "queen photos - insert own" on storage.objects;
create policy "queen photos - insert own" on storage.objects
  for insert with check (
    bucket_id = 'queen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "queen photos - update own" on storage.objects;
create policy "queen photos - update own" on storage.objects
  for update using (
    bucket_id = 'queen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "queen photos - delete own" on storage.objects;
create policy "queen photos - delete own" on storage.objects
  for delete using (
    bucket_id = 'queen-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
--  Done. You can now use the app once you've pasted your project URL + anon key
--  into js/config.js.
-- ============================================================================
