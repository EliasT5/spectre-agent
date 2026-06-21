-- Adds temp + private flags to threads. Safe to rerun.
alter table threads add column if not exists temp_mode boolean not null default false;
alter table threads add column if not exists private boolean not null default false;
alter table threads add column if not exists distilled_at timestamptz;
alter table threads add column if not exists distill_failed boolean not null default false;

-- Performance: filter private-out queries hit this often.
create index if not exists threads_private_idx on threads (private) where private = false;
create index if not exists threads_temp_idx on threads (temp_mode) where temp_mode = true;
create index if not exists threads_dream_pending_idx
  on threads (created_at)
  where private = false and distilled_at is null and temp_mode = false;
