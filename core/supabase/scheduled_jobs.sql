-- Spectre durable scheduler.
-- Run once in Supabase SQL Editor. Safe to rerun.

create table if not exists scheduled_jobs (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  description       text,
  enabled           boolean not null default true,
  schedule_type     text not null check (schedule_type in ('once', 'interval', 'daily')),
  interval_seconds  integer,
  run_at            timestamptz,
  time_of_day       text,
  timezone          text not null default 'UTC',
  target_type       text not null check (target_type in ('chat', 'workshop', 'notify')),
  prompt            text not null,
  model_hint        text,
  thread_id         uuid references threads(id) on delete set null,
  status            text not null default 'idle' check (status in ('idle', 'running', 'failed', 'paused')),
  last_run_at       timestamptz,
  next_run_at       timestamptz,
  last_error        text,
  locked_at         timestamptz,
  locked_by         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists scheduled_job_runs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references scheduled_jobs(id) on delete cascade,
  status        text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  output        text,
  error         text,
  thread_id     uuid references threads(id) on delete set null,
  metadata      jsonb not null default '{}'
);

create index if not exists idx_scheduled_jobs_due
  on scheduled_jobs(enabled, next_run_at)
  where enabled = true;

create index if not exists idx_scheduled_job_runs_job
  on scheduled_job_runs(job_id, started_at desc);

create or replace function touch_scheduled_jobs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists scheduled_jobs_updated_at on scheduled_jobs;
create trigger scheduled_jobs_updated_at
  before update on scheduled_jobs
  for each row
  execute function touch_scheduled_jobs_updated_at();
