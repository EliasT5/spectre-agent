/**
 * Rolling thread compaction (audit B5) — instead of silently dropping history
 * beyond the 50-message fetch window, fold the older portion into a persistent
 * summary at thread.metadata.rolling_summary and feed it back as volatile
 * context each turn. Triggered fire-and-forget after a completed turn; a race
 * between two turns just overwrites — last write wins, content converges.
 */
import { createServiceSupabase } from "@/lib/supabase/server";
import { quickCompleteLiteLLM } from "@/lib/ai/providers/litellm";

const KEEP_TAIL = 30; // newest messages kept verbatim for the next turn's window
const TRIGGER = 48; // compact once the uncovered history exceeds this many messages

export interface RollingSummary {
  text: string;
  covered_to: string; // created_at of the newest message folded into the summary
  updated_at: string;
}

export function readRollingSummary(metadata: unknown): RollingSummary | null {
  const rs = (metadata as { rolling_summary?: RollingSummary } | null)?.rolling_summary;
  return rs && typeof rs.text === "string" && typeof rs.covered_to === "string" ? rs : null;
}

export async function maybeCompactThread(threadId: string): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data: thread } = await supabase
      .from("threads")
      .select("metadata")
      .eq("id", threadId)
      .single();
    const prev = readRollingSummary(thread?.metadata);

    let q = supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("thread_id", threadId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true });
    if (prev) q = q.gt("created_at", prev.covered_to);
    const { data: msgs } = await q;
    const rows = (msgs ?? []).filter((m) => (m.content ?? "").trim());
    if (rows.length <= TRIGGER) return;

    const fold = rows.slice(0, rows.length - KEEP_TAIL);
    const newest = fold[fold.length - 1];
    const transcript = fold
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.content ?? "").slice(0, 2000)}`)
      .join("\n");
    const text = await quickCompleteLiteLLM(
      `Condense this conversation segment into at most 300 words. Keep: the user's goals and decisions, concrete facts and names, unresolved threads, promises made. Drop pleasantries and repetition.` +
        (prev ? `\n\nEarlier summary to merge in:\n${prev.text}` : "") +
        `\n\nSegment:\n${transcript.slice(0, 60_000)}`,
    );
    if (!text) return;

    // Read-modify-write the metadata JSONB (deep-merge, don't clobber other keys).
    const { data: cur } = await supabase
      .from("threads")
      .select("metadata")
      .eq("id", threadId)
      .single();
    const meta: Record<string, unknown> = { ...(cur?.metadata as Record<string, unknown> | null) };
    meta.rolling_summary = {
      text,
      covered_to: String(newest.created_at),
      updated_at: new Date().toISOString(),
    } satisfies RollingSummary;
    await supabase.from("threads").update({ metadata: meta }).eq("id", threadId);
  } catch (err) {
    console.error(`[compact] thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
