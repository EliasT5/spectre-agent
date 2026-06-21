-- Cross-thread message recall: semantic search over raw chat messages so Spectre
-- can answer "what did we decide/discuss in that OTHER conversation last week".
--
-- Mirrors the memory-embeddings pattern exactly: a local-embedder vector(768)
-- column (Ollama nomic-embed-text) + a top-K cosine RPC. Messages are embedded
-- lazily in the background (the nightly dream backfill), NEVER on the chat write
-- path, so sends stay fast. Safe to rerun. If you switch to OpenAI embeddings,
-- change 768 -> 1536 here and re-embed.

alter table messages add column if not exists embedding vector(768);

-- NOTE: deliberately NO ivfflat/approximate index (same rule as
-- generated_media/pdf_chunks). ivfflat with a fixed `lists` count silently
-- returns 0 rows on small tables (a single-probe query lands in an empty
-- list), which killed cross-thread recall on fresh installs. match_messages
-- does an exact `order by embedding <=> query` instead — correct at every
-- size, fast at single-user scale. If messages grows past ~100k embedded
-- rows, add an HNSW index (no empty-probe hole) — not ivfflat. The drop also
-- migrates installs that predate this switch.
drop index if exists idx_messages_embedding;

-- Speeds up the backfill's "rows still missing a vector" scan.
create index if not exists idx_messages_embedding_pending
  on messages (created_at)
  where embedding is null;

-- Top-K message snippets by cosine similarity (cross-thread). Only real
-- conversation turns (user/assistant) are searchable; system/tool rows and
-- unembedded rows are excluded. The caller filters by threshold + excludes the
-- current thread.
create or replace function match_messages(
  query_embedding vector(768),
  match_count int default 8
)
returns table (
  id uuid,
  thread_id uuid,
  role text,
  content text,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select m.id, m.thread_id, m.role, m.content, m.created_at,
         1 - (m.embedding <=> query_embedding) as similarity
  from messages m
  where m.embedding is not null
    and m.role in ('user', 'assistant')
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
