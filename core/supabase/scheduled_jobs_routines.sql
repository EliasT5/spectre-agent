-- Tempus "Routines" — adds push-on-done to the durable scheduler.
-- Run once in Supabase SQL Editor. Safe to rerun.
--
-- When a `chat` job with notify_on_done = true finishes successfully, the
-- scheduler worker fires a push notification deep-linking to the thread that
-- holds the produced report. See worker/scheduler.mjs.

alter table scheduled_jobs
  add column if not exists notify_on_done boolean not null default false;

-- Per-routine persistent state list, carried across one-shot runs. The
-- scheduler injects list_items into the run prompt and parses a trailing
-- ```routine-ops``` block from the output to add/remove items. list_kind is a
-- free label (blacklist | whitelist | notes | reminders | todos | ...) that
-- only changes the wording of the injected instructions. See
-- worker/routine-list.mjs.
alter table scheduled_jobs
  add column if not exists list_kind text,
  add column if not exists list_items jsonb not null default '[]';
