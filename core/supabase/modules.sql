-- Module installs — the registry's persisted half.
--
-- `/api/modules` returns the built-in modules merged over the rows here, so an
-- installed module shows up in the blob without a redeploy. A row's `manifest`
-- is the full jerome.module.json v2 doc (uiMode + ui + permissions intact); the
-- route reads it raw (the trust boundary is install-time validation, not read).
--
-- `ui_mode` is denormalized out of the manifest for cheap filtering. Disabled
-- rows are skipped by the route (status filter). Safe to rerun (idempotent).
create table if not exists module_installs (
  id          uuid primary key default gen_random_uuid(),
  module_id   text not null unique,
  version     text not null,
  ui_mode     text not null default 'data' check (ui_mode in ('native', 'data', 'code')),
  manifest    jsonb not null,
  status      text not null default 'installed' check (status in ('installed', 'disabled')),
  created_at  timestamptz not null default now()
);

create index if not exists module_installs_status_idx on module_installs (status);

-- Service role full access; anon none (the registry is internal).
alter table module_installs enable row level security;

drop policy if exists "service role full access" on module_installs;
create policy "service role full access"
  on module_installs
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
