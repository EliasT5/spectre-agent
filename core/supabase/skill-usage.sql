-- Skill-usage telemetry + the weekly curation proposal schedule.
-- Run once in Supabase SQL Editor. Safe to rerun.
--
-- The broker's skill.read tool logs a row per on-demand skill load (progressive
-- skill loading); POST /api/skills/curate reads 14-day counts + the skill index
-- and PROPOSES keep/merge/prune. Proposal-only — the SkillOpt human gate
-- applies; nothing is ever auto-deleted. Dispatch: worker/scheduler.mjs when
-- target_type = 'skill_curation'.

create table if not exists skill_usage (
  id         uuid primary key default gen_random_uuid(),
  skill      text not null,
  thread_id  text,
  created_at timestamptz not null default now()
);

create index if not exists skill_usage_skill_created_idx
  on skill_usage (skill, created_at desc);

-- 1. Allow target_type = 'skill_curation' (cumulative enum — keep this file
--    LAST among the schedule files in scripts/gen-apply-all.mjs ORDER).
alter table scheduled_jobs drop constraint if exists scheduled_jobs_target_type_check;
alter table scheduled_jobs add constraint scheduled_jobs_target_type_check
  check (target_type in ('chat', 'workshop', 'notify', 'dream', 'proactive', 'skillopt', 'skill_curation'));

-- 2. Seed the weekly curation job if no row exists yet.
insert into scheduled_jobs (
  name, description, enabled, schedule_type, interval_seconds,
  target_type, prompt, next_run_at
)
select
  'skill-curation',
  'Weekly skill-library review — 14d usage + redundancy; proposes keep/merge/prune, never deletes.',
  true,
  'interval',
  604800,
  'skill_curation',
  'POST /api/skills/curate',
  now() + interval '7 days'
where not exists (
  select 1 from scheduled_jobs
  where name = 'skill-curation' and target_type = 'skill_curation'
);
