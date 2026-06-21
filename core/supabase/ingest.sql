-- Ingest events — signals modules push INTO the core (the active/bidirectional
-- direction). A module posts an observation; the core stores it and can react
-- (remember / notify / hand it to Spectre for a proactive turn). Safe to rerun.
create table if not exists ingest_events (
  id          uuid primary key default gen_random_uuid(),
  module      text not null,
  kind        text not null default 'event',
  summary     text,
  data        jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists ingest_events_created_idx on ingest_events (created_at desc);
create index if not exists ingest_events_module_idx on ingest_events (module);

-- Service role full access; anon none (signal payloads are personal, and anon
-- inserts could enqueue proactive turns).
alter table ingest_events enable row level security;

drop policy if exists "service role full access" on ingest_events;
create policy "service role full access"
  on ingest_events
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
