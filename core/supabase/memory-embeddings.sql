-- Semantic memory: local-embedder vector search.
-- The default embedder is local Ollama nomic-embed-text (768-dim); the original
-- column was sized for OpenAI (1536). Resize + add a cosine-similarity RPC.
-- Safe to rerun. If you switch to OpenAI embeddings, change 768 -> 1536 here
-- and re-embed.

-- Also removes the old ivfflat index on installs that predate the exact-KNN
-- switch (see note below).
drop index if exists idx_memory_embedding;

-- Existing rows have no embedding yet, so dropping/re-adding is lossless.
alter table memory drop column if exists embedding;
alter table memory add column embedding vector(768);

-- NOTE: deliberately NO ivfflat/approximate index (same rule as
-- generated_media/pdf_chunks). ivfflat with a fixed `lists` count silently
-- returns 0 rows on small tables (a single-probe query lands in an empty
-- list), which killed recall on fresh installs. Memory stays small after the
-- nightly dedup/decay, so an exact KNN sort is sub-millisecond AND always
-- correct. If memory ever grows past ~100k rows, add an HNSW index (no
-- empty-probe hole) — not ivfflat.

-- Top-K cosine similarity over memories (optionally filtered by category).
create or replace function match_memory(
  query_embedding vector(768),
  match_count int default 8,
  filter_category text default null
)
returns table (
  id uuid,
  content text,
  category text,
  importance smallint,
  similarity float
)
language sql stable
as $$
  select m.id, m.content, m.category, m.importance,
         1 - (m.embedding <=> query_embedding) as similarity
  from memory m
  where m.embedding is not null
    and (filter_category is null or m.category = filter_category)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
