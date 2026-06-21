-- Nightly maintenance schedule (the scheduler's 'dream' target).
-- Run once in Supabase SQL Editor. Safe to rerun.
--
-- POST /api/dream/nightly runs memory consolidation (backfill + dedupe/merge +
-- decay) and a system health sweep (providers + storage -> debugging engine).
-- Dispatch is handled by worker/scheduler.mjs when target_type = 'dream'.
-- (Continuous learning happens per-turn via learnFromExchange, so the old
-- batch thread-distill /api/dream/run was removed.)

-- 1. Allow target_type = 'dream' on scheduled_jobs.
alter table scheduled_jobs drop constraint if exists scheduled_jobs_target_type_check;
alter table scheduled_jobs add constraint scheduled_jobs_target_type_check
  check (target_type in ('chat', 'workshop', 'notify', 'dream', 'proactive', 'skillopt', 'skill_curation'));

-- 2. Insert the daily 03:30 dream schedule if no row exists yet.
insert into scheduled_jobs (
  name,
  description,
  enabled,
  schedule_type,
  time_of_day,
  timezone,
  target_type,
  prompt,
  next_run_at
)
select
  'dream-mode',
  'Nightly maintenance — memory consolidation (dedupe/decay) + system health sweep.',
  true,
  'daily',
  '03:30',
  'UTC',
  'dream',
  'POST /api/dream/nightly',
  case
    when now() < date_trunc('day', now()) + interval '3 hours 30 minutes'
      then date_trunc('day', now()) + interval '3 hours 30 minutes'
    else date_trunc('day', now()) + interval '1 day 3 hours 30 minutes'
  end
where not exists (
  select 1 from scheduled_jobs
  where name = 'dream-mode' and target_type = 'dream'
);
