-- ============================================================================
--  QUEEN TRACKER — Phase 2 schema (voice notes -> inspections/treatments/feedings)
--  Additive to schema.sql. Already applied to the live project; kept here for
--  reproducibility. Safe to re-run (idempotent).
-- ============================================================================
create extension if not exists "pgcrypto";

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  queen_id uuid references public.queens (id) on delete set null,
  hive_label text,
  inspection_date date not null default current_date,
  queen_seen boolean, eggs_seen boolean,
  brood_pattern integer, temperament integer,
  population text, stores text, space text,
  queen_cells boolean, swarm_signs boolean,
  mites text, pests_disease text, actions text, notes text,
  summary text, raw_transcript text,
  created_at timestamptz not null default now()
);

create table if not exists public.treatments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  queen_id uuid references public.queens (id) on delete set null,
  hive_label text,
  treatment_date date not null default current_date,
  product text, target text, dose text, method text, notes text,
  summary text, raw_transcript text,
  created_at timestamptz not null default now()
);

create table if not exists public.feedings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  queen_id uuid references public.queens (id) on delete set null,
  hive_label text,
  feed_date date not null default current_date,
  feed_type text, amount text, notes text,
  summary text, raw_transcript text,
  created_at timestamptz not null default now()
);

create table if not exists public.voice_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  queen_id uuid references public.queens (id) on delete set null,
  hive_label text, audio_path text, transcript text,
  category text, ref_kind text, ref_id uuid, status text default 'new',
  created_at timestamptz not null default now()
);

alter table public.queen_events add column if not exists ref_kind text;
alter table public.queen_events add column if not exists ref_id uuid;

create index if not exists inspections_queen_idx on public.inspections (queen_id);
create index if not exists inspections_user_idx  on public.inspections (user_id);
create index if not exists treatments_queen_idx  on public.treatments (queen_id);
create index if not exists treatments_user_idx   on public.treatments (user_id);
create index if not exists feedings_queen_idx    on public.feedings (queen_id);
create index if not exists feedings_user_idx     on public.feedings (user_id);
create index if not exists voice_notes_queen_idx on public.voice_notes (queen_id);
create index if not exists voice_notes_user_idx  on public.voice_notes (user_id);

alter table public.inspections enable row level security;
alter table public.treatments  enable row level security;
alter table public.feedings    enable row level security;
alter table public.voice_notes enable row level security;

drop policy if exists "own inspections - all" on public.inspections;
create policy "own inspections - all" on public.inspections for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own treatments - all" on public.treatments;
create policy "own treatments - all" on public.treatments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own feedings - all" on public.feedings;
create policy "own feedings - all" on public.feedings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own voice_notes - all" on public.voice_notes;
create policy "own voice_notes - all" on public.voice_notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public) values ('hive-audio','hive-audio',false) on conflict (id) do nothing;
drop policy if exists "hive audio - read own" on storage.objects;
create policy "hive audio - read own" on storage.objects for select using (bucket_id='hive-audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "hive audio - insert own" on storage.objects;
create policy "hive audio - insert own" on storage.objects for insert with check (bucket_id='hive-audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "hive audio - update own" on storage.objects;
create policy "hive audio - update own" on storage.objects for update using (bucket_id='hive-audio' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "hive audio - delete own" on storage.objects;
create policy "hive audio - delete own" on storage.objects for delete using (bucket_id='hive-audio' and (storage.foldername(name))[1] = auth.uid()::text);
