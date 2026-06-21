-- Monitor events — written by the spectre-monitor agent every 5 minutes.
-- Run this in your Supabase SQL Editor after schema.sql.

CREATE TABLE monitor_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity      TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  component     TEXT NOT NULL,
  description   TEXT NOT NULL,
  action_taken  TEXT,
  action_result TEXT,
  raw_vitals    JSONB,
  analysis      JSONB
);

CREATE INDEX idx_monitor_events_created  ON monitor_events (created_at DESC);
CREATE INDEX idx_monitor_events_severity ON monitor_events (severity);

-- Service role full access; anon none (events carry error details/vitals, and
-- anon writes could inject fake "issues" into Spectre's per-turn prompt block).
alter table monitor_events enable row level security;

drop policy if exists "service role full access" on monitor_events;
create policy "service role full access"
  on monitor_events
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Auto-prune: keep only 7 days of events to avoid unbounded growth.
-- Run this as a cron job in Supabase, or add to a pg_cron extension schedule.
-- DELETE FROM monitor_events WHERE created_at < NOW() - INTERVAL '7 days';
