-- Durable chat: runs are queued in the DB, executed by the chat-runner, and
-- streamed to the UI via Realtime — so a generation survives the UI connection
-- dropping (close the laptop, Spectre keeps going; reattach anywhere). Rerunnable.

-- Per-message generation status. Existing rows are complete -> 'done'.
-- New flow: assistant placeholder 'queued' -> 'running' -> 'done'|'error'|'cancelled'.
alter table messages add column if not exists status text not null default 'done';

-- Runner lease columns (mirrors the locked_at/locked_by pattern on scheduled_jobs).
-- The chat-runner sets both atomically with the queued->running claim, heartbeats
-- locked_at every 60 s during execution, and the boot orphan-recovery only reclaims
-- rows whose lease is null or older than STALE_MS (20 min default) — leaving live
-- in-flight runs on sibling/surviving runners untouched.
alter table messages add column if not exists locked_at timestamptz;
alter table messages add column if not exists locked_by text;

create index if not exists messages_status_idx
  on messages (status)
  where status in ('queued', 'running', 'cancelled');

-- Realtime so the UI viewer sees the assistant row fill in live and the runner
-- can pick up work. replica identity full -> UPDATE payloads include content.
alter table messages replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table messages;
  end if;
end $$;
