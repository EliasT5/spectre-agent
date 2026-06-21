-- Per-module data store — the tables a module's declarative backend writes to
-- via the capability shim (src/lib/modules/store.ts). EVERY query is hard-
-- filtered by module_id, so a module only ever touches its OWN namespace.
-- Two shapes:
--   module_kv   — namespaced key→jsonb   (get / set / list / del)
--   module_rows — namespaced append log  (append / rows)
-- Service-role-only (RLS), mirroring notes.sql. Safe to rerun (idempotent).

create table if not exists module_kv (
  module_id   text not null,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (module_id, key)
);

create table if not exists module_rows (
  id          uuid primary key default gen_random_uuid(),
  module_id   text not null,
  collection  text not null,
  doc         jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists module_kv_module_idx on module_kv (module_id);
create index if not exists module_rows_module_collection_idx
  on module_rows (module_id, collection, created_at desc);

-- Service role full access; anon none (per-module data is internal).
alter table module_kv enable row level security;
alter table module_rows enable row level security;

drop policy if exists "service role full access" on module_kv;
create policy "service role full access"
  on module_kv
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "service role full access" on module_rows;
create policy "service role full access"
  on module_rows
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
