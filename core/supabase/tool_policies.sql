-- Persistent tool-permission policies + a call log (quotas/audit).
-- Today the permission broker is module-level in-memory: a core restart cancels
-- every in-flight approval and `allow_session` doesn't survive. These tables let
-- a decision PERSIST (auto-resolve without re-prompting) and bound autonomous
-- tool use with optional per-tool hourly quotas. Safe to rerun.

create table if not exists tool_policies (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,                       -- e.g. mcp__spectre__bash
  scope       text not null default 'global'
              check (scope in ('global','thread','module')),
  scope_id    text,                                -- thread_id / module id; null = global
  decision    text not null check (decision in ('always_allow','always_deny')),
  quota_per_hour int,                              -- null = unlimited
  expires_at  timestamptz,                         -- null = no expiry (allow_session sets a TTL)
  created_at  timestamptz not null default now()
);

-- One live policy per (tool, scope, scope_id); a new decision replaces the old.
create unique index if not exists uq_tool_policies_target
  on tool_policies (tool, scope, coalesce(scope_id, ''));
create index if not exists idx_tool_policies_lookup
  on tool_policies (tool, scope, scope_id);

-- Audit + quota source: one row per resolved gated tool call.
create table if not exists tool_calls (
  id          uuid primary key default gen_random_uuid(),
  tool        text not null,
  thread_id   text,
  decision    text not null,                       -- 'allow' | 'deny'
  auto        boolean not null default false,      -- resolved by a policy (no prompt)
  created_at  timestamptz not null default now()
);
create index if not exists idx_tool_calls_tool_time on tool_calls (tool, created_at desc);
