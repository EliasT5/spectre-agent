export interface Thread {
  id: string;
  title: string | null;
  project_id: string | null;
  pinned: boolean;
  archived: boolean;
  temp_mode: boolean;
  private: boolean;
  distilled_at: string | null;
  distill_failed: boolean;
  model_hint: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  model_used: string | null;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  attachments: Attachment[];
  token_count: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface Attachment {
  type: string;
  storage_path: string;
  mime_type: string;
  name: string;
}

export interface Memory {
  id: string;
  content: string;
  category: string;
  source_msg_id: string | null;
  importance: number;
  last_accessed: string;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string;
  active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Plugin {
  id: string;
  name: string;
  type: "mcp_stdio" | "mcp_sse" | "openapi";
  enabled: boolean;
  config: Record<string, unknown>;
  project_id: string | null;
  tools_cache: unknown[] | null;
  last_synced: string | null;
  created_at: string;
}
