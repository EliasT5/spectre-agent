-- Spectre notes + todos store.
-- Run once in Supabase SQL Editor. Safe to rerun.
--
-- Two kinds in the same table:
--   kind='note' → free-form thought/idea the user dictated. Optional `pinned`.
--   kind='todo' → structured task. Optional `deadline`, `priority`,
--                 `done` checkbox.
--
-- Distinct from `memory` which holds long-term facts about the user /
-- projects. Spectre saves notes via note.add / todo.add and retrieves
-- with note.list / note.search.

create table if not exists notes (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null default 'note' check (kind in ('note', 'todo')),
  content           text not null,
  pinned            boolean not null default false,
  -- todo-specific (null for kind='note')
  deadline          timestamptz,
  priority          text check (priority in ('low', 'medium', 'high', 'urgent')),
  done              boolean not null default false,
  done_at           timestamptz,
  -- provenance
  source_msg_id     uuid references messages(id) on delete set null,
  source_thread_id  uuid references threads(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists notes_kind_idx on notes (kind);
create index if not exists notes_created_at_idx on notes (created_at desc);
create index if not exists notes_pinned_idx on notes (pinned) where pinned = true;
create index if not exists notes_todo_open_idx on notes (deadline asc nulls last) where kind = 'todo' and done = false;

-- Service role full access; anon none (notes are personal).
alter table notes enable row level security;

drop policy if exists "service role full access" on notes;
create policy "service role full access"
  on notes
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
