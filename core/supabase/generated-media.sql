-- Generated media library: screenshots (+ other generated images) with metadata
-- and an embedding, so (a) the agent can RESURFACE past media by description and
-- (b) the UI (Memory tab / Library) can browse it. The image bytes live on the
-- /generated rail (files); this table is the index + recall layer.

create table if not exists generated_media (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,                 -- /generated/<name> filename
  url         text not null,                        -- /generated/<name>
  kind        text not null default 'screenshot',   -- screenshot | image
  caption     text,                                 -- human/agent description (embedded)
  thread_id   uuid references threads(id) on delete set null,
  embedding   vector(768),                          -- nomic-embed-text (EMBED_DIM)
  created_at  timestamptz not null default now()
);

create index if not exists idx_generated_media_created on generated_media (created_at desc);
-- NOTE: deliberately NO ivfflat/approximate index. A media library is small
-- (hundreds–thousands of rows), where an exact KNN sort is sub-millisecond AND
-- always correct. ivfflat with a fixed `lists` count silently drops recall on
-- small tables (a single-probe query lands in an empty list -> 0 rows), which is
-- exactly wrong for "resurface this image". match_generated_media does an exact
-- `order by embedding <=> query` instead.

-- Top-K cosine recall over captions (rows without an embedding are skipped).
create or replace function match_generated_media(
  query_embedding vector(768),
  match_count int default 12
)
returns table (
  id uuid,
  name text,
  url text,
  kind text,
  caption text,
  created_at timestamptz,
  similarity float
)
language sql stable
as $$
  select g.id, g.name, g.url, g.kind, g.caption, g.created_at,
         1 - (g.embedding <=> query_embedding) as similarity
  from generated_media g
  where g.embedding is not null
  order by g.embedding <=> query_embedding
  limit match_count;
$$;
