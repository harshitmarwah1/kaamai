-- KaamAI — Supabase schema (system of record)
-- Apply in the Supabase SQL editor (or `supabase db push`) on a fresh project.
-- Everything the app persists lives here; localStorage is only an offline cache.
--
-- Auth: email OTP (Supabase Auth "Email" provider, 6-digit code). Emails are
-- delivered via a custom SMTP provider (Resend) configured in the dashboard.

-- ---------------------------------------------------------------------------
-- profiles: 1:1 with auth.users; identity + per-user gamification
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  name            text,
  xp              int  not null default 0,
  streak          int  not null default 0,
  last_active_day date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- assistants: the artifact the user builds. One per user for rung 1, but the
-- table allows many so future rungs can add more without a migration.
-- ---------------------------------------------------------------------------
create table if not exists assistants (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  role              text,
  task              text,
  audience          text,
  name              text,
  instructions_text text not null default '',
  status            text not null default 'building',  -- building|tested|in_use|complete
  answers           jsonb not null default '{}'::jsonb,
  step_progress     jsonb not null default '{}'::jsonb,
  step_index        int  not null default 0,
  completed_steps   text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- step_completions: append-only, one row per finished step (XP audit + funnel)
-- ---------------------------------------------------------------------------
create table if not exists step_completions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  assistant_id uuid not null references assistants(id) on delete cascade,
  step_id      text not null,
  xp_awarded   int  not null default 0,
  completed_at timestamptz not null default now(),
  unique (assistant_id, step_id)
);

-- ---------------------------------------------------------------------------
-- events: append-only funnel analytics
-- ---------------------------------------------------------------------------
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists assistants_user_id_idx       on assistants (user_id);
create index if not exists step_completions_user_id_idx on step_completions (user_id);
create index if not exists events_type_created_idx       on events (type, created_at);

-- ---------------------------------------------------------------------------
-- Row-Level Security: each user reads/writes only their own rows.
-- ---------------------------------------------------------------------------
alter table profiles         enable row level security;
alter table assistants       enable row level security;
alter table step_completions enable row level security;
alter table events           enable row level security;

drop policy if exists own_profile on profiles;
create policy own_profile on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists own_assistants on assistants;
create policy own_assistants on assistants
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_completions on step_completions;
create policy own_completions on step_completions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists own_events_insert on events;
create policy own_events_insert on events
  for insert with check (auth.uid() = user_id);

drop policy if exists own_events_select on events;
create policy own_events_select on events
  for select using (auth.uid() = user_id);
