-- Web Push subscription store.
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor).

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- Service role has full access; anon has none (subscriptions are internal).
alter table push_subscriptions enable row level security;

create policy "service role full access"
  on push_subscriptions
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
