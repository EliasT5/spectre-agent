/**
 * Ingest — the active/bidirectional channel, as a reusable function.
 *
 * A module PUSHES a signal in (sensor reading, observation, anything) and the
 * core can react:
 *   - store it (always) in ingest_events,
 *   - remember it (-> long-term memory),
 *   - notify the user (-> web push, proactive),
 *   - enqueue a Jerome turn (-> the durable chat-runner runs the full brain on
 *     the signal + instruction; Jerome can then notify/act with its own tools).
 *
 * Extracted from the /api/ingest route so BOTH the route and the module
 * capability shim (ctx.ingest) share ONE implementation. The route is now a
 * thin wrapper; behavior is unchanged.
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { addMemory } from "@/lib/ai/memory";
import { reportEvent } from "@/lib/monitor/report";

export interface IngestEvent {
  module: string;
  kind?: string;
  summary?: string;
  data?: unknown;
  remember?: boolean; // -> long-term memory
  notify?: boolean; // -> proactive web push
  enqueue?: boolean; // -> a durable Jerome turn reacts to the signal
  instruction?: string; // what Jerome should do with it (when enqueue)
  threadId?: string;
}

export interface IngestResult {
  id?: string;
  stored: boolean;
  remembered?: boolean;
  notified?: boolean;
  enqueued?: { threadId: string | null; assistantMessageId?: string };
}

/** Validation/store failure surfaced to the route as a stable code. */
export class IngestError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
    this.name = "IngestError";
  }
}

/**
 * Run the full ingest pipeline. Throws IngestError on a bad request / store
 * failure; remember/notify/enqueue are best-effort (never throw the call).
 */
export async function runIngest(evt: IngestEvent): Promise<IngestResult> {
  const { module, kind, summary, data, remember, notify, enqueue, instruction, threadId } =
    evt ?? ({} as IngestEvent);

  if (!module || typeof module !== "string") {
    throw new IngestError("module required", 400);
  }

  const supabase = createServiceSupabase();

  const { data: row, error } = await supabase
    .from("ingest_events")
    .insert({ module, kind: typeof kind === "string" ? kind : "event", summary: summary ?? null, data: data ?? null })
    .select("id")
    .single();
  if (error) {
    void reportEvent({ severity: "warning", component: `ingest:${module}`, description: `store failed: ${error.message}` });
    throw new IngestError(error.message, 500);
  }

  const result: IngestResult = { id: row?.id, stored: true };
  const text = typeof summary === "string" ? summary : "";

  if (remember && text) {
    try {
      await addMemory({ content: `[${module}] ${text}`, category: "ingest", importance: 4 });
      result.remembered = true;
    } catch { /* best effort */ }
  }

  if (notify && text) {
    try {
      const { sendPush } = await import("@/lib/notify");
      await sendPush({ title: `Jerome · ${module}`, body: text.slice(0, 160), url: "/" });
      result.notified = true;
    } catch { /* push best-effort (no VAPID/sub is fine) */ }
  }

  // Full active loop: hand the signal to Jerome as a durable turn. The
  // chat-runner picks up the queued placeholder and runs the brain (with memory
  // + tools + push), so Jerome can react proactively.
  if (enqueue) {
    let tid = typeof threadId === "string" && threadId ? threadId : null;
    if (!tid) {
      const { data: t } = await supabase.from("threads").insert({ title: `${module} signal` }).select("id").single();
      tid = t?.id ?? null;
    }
    if (tid) {
      const content =
        `[Signal from module "${module}"${kind ? ` (${kind})` : ""}]\n${text}` +
        (instruction ? `\n\nInstruction: ${instruction}` : "") +
        (data ? `\n\nData: ${JSON.stringify(data).slice(0, 2000)}` : "");
      await supabase.from("messages").insert({ thread_id: tid, role: "user", content, status: "done" });
      const { data: ph } = await supabase
        .from("messages")
        .insert({ thread_id: tid, role: "assistant", content: "", status: "queued" })
        .select("id")
        .single();
      result.enqueued = { threadId: tid, assistantMessageId: ph?.id };
    }
  }

  return result;
}
