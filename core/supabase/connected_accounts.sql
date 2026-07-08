-- Connected mail/calendar accounts (Microsoft + Google), multi-account.
-- Replaces the single app_config 'ms_graph_tokens' blob: one row per account so a
-- user can connect several Microsoft and/or Google accounts and Spectre reads
-- calendars (and later email, on-demand) across all of them.
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor).

create table if not exists connected_accounts (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,               -- 'microsoft' | 'google'
  account_email text not null,               -- identity within a provider
  account_name  text,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz,                 -- access-token expiry (ISO)
  scopes        text,                         -- granted scopes, space-separated
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (provider, account_email)           -- re-connecting an account updates it
);

create index if not exists connected_accounts_provider_idx
  on connected_accounts (provider);

-- Service role has full access; anon/authenticated have none (tokens are internal).
alter table connected_accounts enable row level security;

create policy "service role full access"
  on connected_accounts
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
