-- SkillOpt run schedule (the scheduler's 'skillopt' target) — Step 5.
-- Run once in Supabase SQL Editor. Safe to rerun (idempotent).
--
-- POST /api/skillopt/run drives ONE bounded offline optimization round for the
-- configured skill (rollout incumbent on train -> score -> OPUS proposes edits ->
-- budget -> apply -> VALIDATION GATE on val -> evaluate champion on test) and
-- ledgers the result to skillopt_runs. It is a DRY-RUN: accepting a candidate
-- writes skill_vN.md + best_skill.md on disk (both gitignored) — it NEVER touches
-- the live skills/<skill>/SKILL.md. That workshop-gated deploy is Step 6.
-- Dispatch is handled by worker/scheduler.mjs when target_type = 'skillopt'.
--
-- Depends on supabase/skillopt.sql (the skillopt_runs ledger, Step 4).

-- 1. Allow target_type = 'skillopt' on scheduled_jobs (keep prior targets).
alter table scheduled_jobs drop constraint if exists scheduled_jobs_target_type_check;
alter table scheduled_jobs add constraint scheduled_jobs_target_type_check
  check (target_type in ('chat', 'workshop', 'notify', 'dream', 'proactive', 'skillopt', 'skill_curation'));

-- 2. Insert a weekly off-hours SkillOpt schedule if no row exists yet.
--    DISABLED by default — flip enabled=true once you want the optimizer to run
--    offline rounds on its own. The cadence (~weekly, 604800s) runs well after
--    the nightly dream pass so the two never contend for the model. The skill to
--    optimize is carried in the prompt field (default 'memory'); the run endpoint
--    parses it from there. interval_seconds is used because the schema's
--    schedule_type CHECK is ('once','interval','daily') — there is no 'weekly',
--    so a 7-day interval is the schema-compatible way to express ~weekly.
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
  'skillopt-run',
  'Weekly bounded SkillOpt optimization round for the configured skill (rollout -> reflect -> val-gate -> test). DRY-RUN: ledgers to skillopt_runs, never writes the live SKILL.md. Disabled by default.',
  false,
  'interval',
  604800,
  'UTC',
  'skillopt',
  'memory',
  now() + interval '7 days'
where not exists (
  select 1 from scheduled_jobs
  where name = 'skillopt-run' and target_type = 'skillopt'
);
