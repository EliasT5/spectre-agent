-- Bounded proactive run (the scheduler's 'proactive' target) — P1.1.
-- Run once in Supabase SQL Editor. Safe to rerun.
--
-- POST /api/proactive/bounded-run spawns Spectre's proactive brain with a SAFE,
-- read-mostly MCP tool whitelist (memory read/write, push notify, schedule /
-- calendar / analytics READ) under a wall-clock + per-tool hourly quota budget.
-- It pre-seeds short-TTL always_allow tool_policies so whitelisted calls
-- auto-resolve, captures the run to monitor_events, and degrades to the
-- proposal-only heartbeat if the tool_policies table isn't applied yet.
-- Dispatch is handled by worker/scheduler.mjs when target_type = 'proactive'.
--
-- Depends on supabase/tool_policies.sql (P1.2) for full tool-using behaviour;
-- without it the run still works but degrades to proposal-only.

-- 1. Allow target_type = 'proactive' on scheduled_jobs (keep prior targets).
alter table scheduled_jobs drop constraint if exists scheduled_jobs_target_type_check;
alter table scheduled_jobs add constraint scheduled_jobs_target_type_check
  check (target_type in ('chat', 'workshop', 'notify', 'dream', 'proactive', 'skillopt', 'skill_curation'));

-- 2. Insert a 4-hourly proactive schedule if no row exists yet (matches the
--    legacy heartbeat cadence). Disabled by default — flip enabled=true once
--    tool_policies.sql is applied and you want the brain acting on its own.
insert into scheduled_jobs (
  name,
  description,
  enabled,
  schedule_type,
  interval_seconds,
  timezone,
  target_type,
  prompt,
  next_run_at
)
select
  'proactive-run',
  'Bounded proactive turn — Spectre acts on its own with a safe tool whitelist (memory/notify/read-only) under a wall-clock + quota budget.',
  false,
  'interval',
  14400,
  'UTC',
  'proactive',
  'POST /api/proactive/bounded-run',
  now() + interval '4 hours'
where not exists (
  select 1 from scheduled_jobs
  where name = 'proactive-run' and target_type = 'proactive'
);
