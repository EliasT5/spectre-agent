-- supabase/tempus-native.sql
-- Native Tempus tables in Spectre's Supabase. Prefixed `tempus_` to
-- avoid collision with anything else in the schema. Safe to rerun.

create table if not exists tempus_projects (
  id           text primary key,
  name         text not null,
  color        text not null default '#6366f1',
  icon         text default 'folder',
  description  text default '',
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists tempus_time_entries (
  id           text primary key,
  project_id   text not null references tempus_projects(id) on delete cascade,
  description  text default '',
  start_time   timestamptz not null,
  end_time     timestamptz,
  duration_ms  bigint,
  source       text not null default 'manual',
  tags         jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Single-row table -- id is always 1.
create table if not exists tempus_active_timer (
  id           int primary key default 1 check (id = 1),
  project_id   text not null references tempus_projects(id),
  start_time   timestamptz not null,
  pause_start  timestamptz,
  paused_ms    bigint not null default 0,
  description  text default ''
);

create index if not exists tempus_time_entries_project_idx on tempus_time_entries(project_id);
create index if not exists tempus_time_entries_start_idx on tempus_time_entries(start_time desc);
create index if not exists tempus_projects_archived_idx on tempus_projects(is_archived) where is_archived = false;
