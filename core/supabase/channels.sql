-- Messaging channels: inbound webhook -> durable Spectre turn -> outbound delivery.
-- A channel chat reuses ONE thread per (channel, sender) so context persists; the
-- thread carries metadata.channel = { type, chat_id } so the outbound worker knows
-- where to send the reply. Default-deny: only allowed senders are acted on.

create table if not exists channel_accounts (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  sender_id text not null,
  thread_id uuid references threads(id) on delete set null,
  allowed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (channel, sender_id)
);

-- Outbound dedupe marker: an assistant reply on a channel-bound thread is sent
-- exactly once, then stamped delivered_at. Durable (survives worker restarts) —
-- the chat-runner's orphan recovery shows why in-process sent-sets are unsafe.
alter table messages add column if not exists delivered_at timestamptz;

-- The outbound worker scans for undelivered, finished assistant replies.
create index if not exists idx_messages_undelivered
  on messages (thread_id)
  where delivered_at is null and status = 'done' and role = 'assistant';

-- Service role full access; anon none (this is the inbound sender allowlist —
-- anon write access would let anyone allowlist themselves).
alter table channel_accounts enable row level security;

drop policy if exists "service role full access" on channel_accounts;
create policy "service role full access"
  on channel_accounts
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
