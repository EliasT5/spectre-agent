-- ============================================================
-- PDF LIBRARY — documents + RAG chunks + reading-session threads
-- ============================================================
-- Idempotent migration. Run via Supabase SQL editor (or psql).
-- Adds:
--   * pdf_documents — uploaded PDF metadata + intake status
--   * pdf_chunks    — page-aware text chunks with pgvector embeddings
--   * threads.metadata column — used to mark a thread as a "reading
--                               session" so /api/threads/[id]/messages
--                               can scope RAG retrieval to its pdf_ids
--   * match_pdf_chunks RPC for top-k cosine retrieval
-- ============================================================

CREATE TABLE IF NOT EXISTS pdf_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  title         TEXT,
  summary       TEXT,
  category      TEXT,
  tags          TEXT[] DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','ready','failed')),
  file_path     TEXT NOT NULL,
  file_size     BIGINT,
  page_count    INTEGER,
  error         TEXT,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pdf_documents_status   ON pdf_documents(status);
CREATE INDEX IF NOT EXISTS idx_pdf_documents_uploaded ON pdf_documents(uploaded_at DESC);

CREATE TABLE IF NOT EXISTS pdf_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID NOT NULL REFERENCES pdf_documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  page_start    INTEGER NOT NULL,
  page_end      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  token_count   INTEGER,
  embedding     vector(768),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdf_chunks_doc       ON pdf_chunks(doc_id);
-- NOTE: no ivfflat/approximate vector index on purpose. match_pdf_chunks ALWAYS
-- filters `WHERE doc_id = ANY(doc_ids)` (a reading session = a handful of PDFs),
-- so the planner filters on idx_pdf_chunks_doc first and does an EXACT cosine
-- sort over that small subset — sub-ms and always correct. An ivfflat index here
-- is actively harmful: a single-probe scan lands in a list that may hold none of
-- the attached docs' chunks, returning 0 hits so RAG silently never fires (the
-- same pgvector small-table/post-filter trap that bit generated_media).

-- threads.metadata: marks a thread as kind='pdf-session' and stores
-- the open-set of pdf_ids it's bound to. Used by the chat route to
-- scope RAG retrieval. Defaults to '{}' so existing threads keep
-- working unchanged.
ALTER TABLE threads ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_threads_metadata_kind ON threads ((metadata->>'kind'));

-- Top-k retrieval scoped to the open-set of PDFs.
CREATE OR REPLACE FUNCTION match_pdf_chunks(
  query_embedding vector(768),
  doc_ids UUID[],
  match_count INT
) RETURNS TABLE (
  id UUID,
  doc_id UUID,
  page_start INT,
  page_end INT,
  text TEXT,
  similarity FLOAT
) LANGUAGE sql STABLE AS $$
  SELECT
    id,
    doc_id,
    page_start,
    page_end,
    text,
    1 - (embedding <=> query_embedding) AS similarity
  FROM pdf_chunks
  WHERE doc_id = ANY(doc_ids) AND embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
