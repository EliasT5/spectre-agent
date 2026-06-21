-- SkillOpt — Step 6: the APPROVAL-GATED DEPLOY column.
-- Run once in Supabase SQL Editor. Safe to rerun (idempotent).
--
-- Adds `deploy_status` to the skillopt_runs ledger (supabase/skillopt.sql).
--
-- The whole point of Step 6: an ACCEPTED candidate (val-gate passed) becomes a
-- PENDING deploy — it does NOT auto-promote to the live skills/<skill>/SKILL.md.
-- Only an EXPLICIT human approve action copies the gitignored candidate
-- (skillopt/envs/<skill>/skill_v<N>.md) onto the live doc.
--
--   deploy_status NULL        → not a deploy candidate (a rejected round)
--   deploy_status 'pending'   → accepted, awaiting human approval (no live write)
--   deploy_status 'approved'  → human approved; the live SKILL.md WAS written
--   deploy_status 'discarded' → human discarded; the live SKILL.md untouched
--
-- `deployed_at` is stamped when (and only when) a deploy is approved.
--
-- RLS stays exactly as skillopt.sql left it (service role full access, anon
-- none) — adding a column does not change the policy, so nothing to redo here.

alter table skillopt_runs
  add column if not exists deploy_status text;

alter table skillopt_runs
  add column if not exists deployed_at timestamptz;

-- Constrain the allowed values (NULL allowed = not a deploy candidate).
-- drop-then-add so a rerun re-applies the latest definition cleanly.
alter table skillopt_runs
  drop constraint if exists skillopt_runs_deploy_status_check;
alter table skillopt_runs
  add constraint skillopt_runs_deploy_status_check
  check (deploy_status is null or deploy_status in ('pending', 'approved', 'discarded'));

-- Pending deploys are read on every approval-gate poll (listPendingDeploys()).
create index if not exists idx_skillopt_runs_deploy_pending
  on skillopt_runs (created_at desc)
  where deploy_status = 'pending';
