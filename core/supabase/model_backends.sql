-- Model backends — user-taught, modular model backends (api / cli-server / cli-command).
--
-- The unified registry's persisted half. The core dual-writes here AND to
-- <dataDir>/backends/backends.json (the mcp-broker reads that file to register
-- cli-dispatch tools — it has no DB access). `spec` is the full ModelBackend v1
-- doc; the loader validates it with zod on read.
--
-- Secrets (provider api keys) are NEVER stored here — they are forwarded to the
-- LiteLLM gateway, which encrypts them in its own store (store_model_in_db).
-- `status` mirrors spec.enabled for cheap filtering. Safe to rerun (idempotent).
create table if not exists model_backends (
  id          text primary key,
  kind        text not null check (kind in ('api', 'cli-server', 'cli-command')),
  label       text not null,
  status      text not null default 'enabled' check (status in ('enabled', 'disabled')),
  spec        jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists model_backends_status_idx on model_backends (status);

-- Service role full access; anon none (the registry is internal).
alter table model_backends enable row level security;

drop policy if exists "service role full access" on model_backends;
create policy "service role full access"
  on model_backends
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
