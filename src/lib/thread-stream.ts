/**
 * Live message feed for one thread — the SSE replacement for the old direct
 * Supabase Realtime subscription. The browser holds NO storage credentials:
 * EventSource hits the core's /api/threads/:id/stream through the shell proxy
 * (PIN cookie at the edge, CORE_TOKEN injected), and the core relays Realtime
 * server-side. On every (re)connect the server sends a full `snapshot`, then
 * `row` events per inserted/updated message — so EventSource's automatic
 * reconnect self-heals anything missed while disconnected.
 */

export type ThreadStreamRow = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  status: string | null;
  tool_calls: unknown[] | null;
  created_at: string;
};

export function subscribeThreadStream<T extends ThreadStreamRow>(
  threadId: string,
  handlers: { onSnapshot: (rows: T[]) => void; onRow: (row: T) => void },
): () => void {
  const es = new EventSource(`/api/threads/${threadId}/stream`);
  es.addEventListener("snapshot", (e) => {
    try {
      const rows = JSON.parse((e as MessageEvent).data);
      if (Array.isArray(rows)) handlers.onSnapshot(rows);
    } catch {
      /* malformed frame — the next snapshot heals */
    }
  });
  es.addEventListener("row", (e) => {
    try {
      const row = JSON.parse((e as MessageEvent).data);
      if (row?.id) handlers.onRow(row);
    } catch {
      /* malformed frame — the next snapshot heals */
    }
  });
  return () => es.close();
}
