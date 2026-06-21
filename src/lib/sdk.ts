/**
 * @spectre/sdk (in-shell for now; published as a package at release).
 *
 * The fixed contract a module uses to talk to the private core. Modules never
 * touch the core directly — they call `spectre.*`, which goes through the shell's
 * /api proxy (which injects CORE_TOKEN) to the core on its loopback port. This
 * is the "port + set schema": modules speak this, the core speaks /api.
 */

export const SDK_VERSION = 1;

/** Raw call to a core endpoint, through the shell proxy. */
export async function call<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path.startsWith("/") ? path : `/${path}`}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(`core ${path} -> ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface MemoryItem {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  similarity?: number;
}
/** A matched past-message snippet from cross-thread recall (raw chat messages,
 *  not the distilled memory store). */
export interface CrossThreadMessageItem {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  similarity: number;
}
export interface MonitorEvent {
  id: string;
  created_at: string;
  severity: "info" | "warning" | "critical";
  component: string;
  description: string;
}

/** The capability surface modules build on. */
export const spectre = {
  memory: {
    search: (q: string) => call<{ items: MemoryItem[]; categories: string[]; mode: string }>(`/memory?q=${encodeURIComponent(q)}`),
    /** Cross-thread message recall: semantic search over raw past conversations
     *  ("what did we decide in that other thread"), distinct from `search` which
     *  hits the distilled long-term memory store. */
    searchThreads: (q: string) =>
      call<{ items: CrossThreadMessageItem[]; mode: string; count: number }>(
        `/threads/search?q=${encodeURIComponent(q)}`,
      ),
    list: () => call<{ items: MemoryItem[]; categories: string[] }>(`/memory`),
    add: (content: string, category?: string) =>
      call(`/memory`, { method: "POST", body: JSON.stringify({ content, category }) }),
    forget: (id: string) => call(`/memory/${id}`, { method: "DELETE" }),
  },
  chat: {
    newThread: (title?: string) => call<{ id: string }>(`/threads`, { method: "POST", body: JSON.stringify({ title: title ?? "" }) }),
    enqueue: (threadId: string, content: string) =>
      call<{ assistantMessageId: string }>(`/threads/${threadId}/enqueue`, { method: "POST", body: JSON.stringify({ content }) }),
    stop: (threadId: string, messageId: string) =>
      call(`/threads/${threadId}/stop`, { method: "POST", body: JSON.stringify({ messageId }) }),
  },
  monitor: () => call<{ summary: { warnings: number; criticals: number }; events: MonitorEvent[] }>(`/monitor?limit=30`),

  // ── read surface (data a module can use; the engine stays hidden) ──
  usage: () => call(`/usage`),
  health: () => call<{ name: string; coreApiVersion: number }>(`/health`),
  models: () => call<{ providers: string[]; models: { id: string; provider: string; displayName: string }[] }>(`/models`),
  threads: {
    list: () => call<Array<{ id: string; title: string | null; created_at: string }>>(`/threads`),
    messages: (id: string) => call(`/threads/${id}/messages`),
  },
  schedules: () => call(`/schedules`),
  calendar: () => call(`/calendar/events`),
  skills: () => call(`/skills`),

  // ── ingest: push a signal IN; the core can react (the active channel) ──
  ingest: (e: {
    module: string;
    kind?: string;
    summary?: string;
    data?: unknown;
    remember?: boolean; // -> long-term memory
    notify?: boolean; // -> proactive web push
    enqueue?: boolean; // -> a durable Spectre turn reacts to the signal
    instruction?: string; // what Spectre should do with it (when enqueue)
    threadId?: string;
  }) =>
    call<{ id: string; stored: boolean; remembered?: boolean; notified?: boolean; enqueued?: { threadId: string; assistantMessageId: string } }>(
      `/ingest`,
      { method: "POST", body: JSON.stringify(e) },
    ),
  ingestHistory: () =>
    call<{ events: Array<{ id: string; module: string; kind: string; summary: string | null; created_at: string }> }>(`/ingest`),

  config: {
    get: <T = unknown>(key: string) => call<{ key: string; value: T }>(`/app-config/${key}`),
    set: (key: string, value: unknown) => call(`/app-config/${key}`, { method: "PUT", body: JSON.stringify({ value }) }),
  },

  /**
   * A module's OWN backend, dispatched at /api/m/<id>/* through the core's
   * permission-gated capability shim. Self-scoped: the id is bound here, so a
   * schema can only ever reach ITS OWN endpoints. `path` is relative to the
   * module's backend root (e.g. "/recent"). NOT in SchemaRuntime's SDK_CALLS
   * table — module sources are self-scoped and need no sdk grant.
   */
  module: (id: string) => ({
    call: <T = unknown>(path: string, init?: RequestInit) =>
      call<T>(`/m/${encodeURIComponent(id)}${path.startsWith("/") ? path : `/${path}`}`, init),
  }),

  /** escape hatch for endpoints without a typed helper yet */
  raw: call,
};

export type { ModuleManifest } from "./modules";
