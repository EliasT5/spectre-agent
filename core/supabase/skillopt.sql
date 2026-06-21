-- SkillOpt — the optimization-round LEDGER (Step 4).
-- Run once in Supabase SQL Editor. Safe to rerun (idempotent).
--
-- One row per offline optimization ROUND for a skill: the train score, the
-- validation-gate decision (incumbent vs candidate val scores + delta), whether
-- the candidate was ACCEPTED, how many edits were applied, the held-out test
-- score of the champion, and a metadata blob carrying the proposed edits + a
-- line diff so a round can be eyeballed after the fact.
--
-- This is a DRY-RUN ledger: accepting a candidate writes skill_vN.md +
-- best_skill.md on disk (both gitignored) — it NEVER touches the live
-- skills/<skill>/SKILL.md. That deploy is Step 6, behind the workshop gate, and
-- is what `workshop_task_id` will eventually link to.
--
-- RLS idiom mirrors supabase/notes.sql exactly: service role full access, anon
-- none (this is personal optimization history).

create table if not exists skillopt_runs (
  id                    uuid primary key default gen_random_uuid(),
  skill_name            text not null,
  parent_version        text,
  new_version           text,
  train_score           float,
  incumbent_val_score   float,
  candidate_val_score   float,
  val_delta             float,
  accepted              boolean not null default false,
  edit_count            int,
  test_score            float,
  workshop_task_id      uuid,
  metadata              jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists idx_skillopt_runs_skill_created
  on skillopt_runs (skill_name, created_at desc);

-- Service role full access; anon none (optimization history is personal).
alter table skillopt_runs enable row level security;

drop policy if exists "service role full access" on skillopt_runs;
create policy "service role full access"
  on skillopt_runs
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
