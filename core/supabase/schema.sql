-- Spectre Database Schema
-- Run this in your Supabase SQL Editor

-- Enable pgvector for memory embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- APP CONFIG (key-value for session PIN, preferences, etc.)
-- ============================================================
CREATE TABLE app_config (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROJECTS (group threads + plugins)
-- ============================================================
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT DEFAULT '#6366f1',
  active        BOOLEAN DEFAULT TRUE,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- THREADS
-- ============================================================
CREATE TABLE threads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  pinned        BOOLEAN DEFAULT FALSE,
  archived      BOOLEAN DEFAULT FALSE,
  model_hint    TEXT,
  reasoning_effort TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
CREATE INDEX idx_threads_project ON threads(project_id);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content       TEXT,
  model_used    TEXT,
  tool_calls    JSONB,
  tool_call_id  TEXT,
  attachments   JSONB DEFAULT '[]',
  token_count   INTEGER,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

-- ============================================================
-- MEMORY (long-term facts)
-- ============================================================
CREATE TABLE memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  category      TEXT DEFAULT 'general',
  source_msg_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  -- Must equal EMBED_DIM (default 768 = nomic-embed-text). The memory-embeddings
  -- migration also drop+re-adds this at 768; keep the base consistent so applying
  -- schema.sql alone isn't a silent recall-breaker for self-hosters.
  embedding     vector(768),
  importance    SMALLINT DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  last_accessed TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_embedding ON memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_memory_category ON memory(category);

-- ============================================================
-- PLUGINS (MCP servers + OpenAPI imports)
-- ============================================================
CREATE TABLE plugins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('mcp_stdio', 'mcp_sse', 'openapi')),
  enabled       BOOLEAN DEFAULT TRUE,
  config        JSONB NOT NULL DEFAULT '{}',
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  tools_cache   JSONB,
  last_synced   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TOOL EXECUTION LOG
-- ============================================================
CREATE TABLE tool_executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
  plugin_id     UUID REFERENCES plugins(id) ON DELETE SET NULL,
  tool_name     TEXT NOT NULL,
  input         JSONB,
  output        JSONB,
  status        TEXT CHECK (status IN ('success', 'error', 'timeout')),
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOICE SESSIONS
-- ============================================================
CREATE TABLE voice_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID REFERENCES threads(id) ON DELETE SET NULL,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  transcript    JSONB DEFAULT '[]',
  duration_sec  INTEGER
);

-- ============================================================
-- FILE UPLOADS metadata
-- ============================================================
CREATE TABLE uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path  TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT,
  thread_id     UUID REFERENCES threads(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WORKSHOP TASKS (Spectre self-improvement via Claude Code)
-- ============================================================
CREATE TABLE workshop_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  branch_name   TEXT,
  pr_url        TEXT,
  pr_number     INTEGER,
  claude_output TEXT DEFAULT '',
  error         TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workshop_tasks_status ON workshop_tasks(status);
CREATE INDEX idx_workshop_tasks_created ON workshop_tasks(created_at DESC);

-- ============================================================
-- Auto-update updated_at on threads
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER threads_updated_at
  BEFORE UPDATE ON threads
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Update thread.updated_at when a message is inserted
-- ============================================================
CREATE OR REPLACE FUNCTION touch_thread_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE threads SET updated_at = NOW() WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_touch_thread
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION touch_thread_on_message();
