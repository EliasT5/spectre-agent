/**
 * Cross-thread message recall — semantic search over raw past CHAT MESSAGES
 * (not the distilled `memory` store), so Jerome can surface "what we
 * decided/discussed in that OTHER conversation last week".
 *
 *   SEARCH: embed the query, vector-search the top-K messages via the
 *           `match_messages` RPC (mirrors `match_memory`), threshold-filter,
 *           and optionally exclude the current thread.
 *   INJECT: render a compact, token-bounded system-prompt block of cross-thread
 *           hits — appended ADDITIVELY alongside the existing recall/issues
 *           blocks. Any failure (embedder down, RPC error, no hits) yields "",
 *           so normal chat is never affected.
 *
 * Messages are embedded lazily by the nightly dream backfill
 * (`backfillMessageEmbeddings` in lib/distill/consolidate.ts), NEVER on the chat
 * write path — sends stay fast.
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne } from "./embeddings";

// Cross-thread is noisier than same-thread context, so be more selective than
// memory recall (0.45) to avoid bleeding unrelated conversations into the brain.
const CROSS_THREAD_MIN_SIMILARITY = 0.5;
const CROSS_THREAD_K = 3;
// Keep the injected block tight; one snippet should never balloon the prompt.
const SNIPPET_MAX_CHARS = 160;

export interface CrossThreadHit {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  similarity: number;
}

/**
 * Top-K past messages relevant to `query`, threshold-filtered. Optionally
 * excludes one thread (the current conversation) so we don't echo in-thread
 * history. Guarded: returns [] on any failure.
 */
export async function searchMessagesAcrossThreads(
  query: string,
  opts: { excludeThreadId?: string; k?: number; minSimilarity?: number } = {},
): Promise<CrossThreadHit[]> {
  const text = query.trim();
  if (!text) return [];
  const k = opts.k ?? CROSS_THREAD_K;
  const minSim = opts.minSimilarity ?? CROSS_THREAD_MIN_SIMILARITY;
  try {
    const vec = await embedOne(text);
    const supabase = createServiceSupabase();
    const { data, error } = await supabase.rpc("match_messages", {
      query_embedding: vec,
      // Fetch a few extra so excluding the current thread still leaves k.
      match_count: k + (opts.excludeThreadId ? 5 : 2),
    });
    if (error || !Array.isArray(data)) return [];
    return (data as CrossThreadHit[])
      .filter(
        (m) =>
          m.thread_id !== opts.excludeThreadId &&
          (m.similarity ?? 0) >= minSim &&
          typeof m.content === "string" &&
          m.content.trim().length > 0,
      )
      .slice(0, k);
  } catch (err) {
    console.error(
      `[cross-thread] search failed: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/** Human-friendly relative date for a hit ("today" / "3 days ago" / a date). */
function formatWhen(isoString: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "earlier";
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  return d.toLocaleDateString();
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_MAX_CHARS ? `${t.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…` : t;
}

/**
 * Render cross-thread hits as a compact system-prompt section (or "" when there
 * are none — purely additive, never alters the rest of the prompt).
 */
export function buildCrossThreadBlock(hits: CrossThreadHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits
    .map((h) => `- [${formatWhen(h.created_at)}] ${h.role}: ${clip(h.content)}`)
    .join("\n");
  return (
    `\n\n## Relevant past conversations\n` +
    `Snippets from OTHER threads that relate to this message. Reference them if ` +
    `helpful (e.g. "we discussed this before…"), but stay focused on the current ` +
    `conversation and don't mention "search" or "embeddings".\n${lines}\n`
  );
}
