/**
 * Continuous, token-bounded memory — the "Hermes-style" learn/recall loop.
 *
 *   RECALL: each turn, vector-search the top-K memories relevant to the user's
 *           message and inject a compact block into the system prompt. Tokens
 *           stay bounded no matter how much Jerome has learned (we never dump
 *           the whole store).
 *   LEARN:  after each turn, a cheap LOCAL model extracts durable facts from
 *           the exchange and stores them (embedded). Fire-and-forget, so it
 *           never blocks the reply. The idle dream pass later consolidates +
 *           dedupes so the store stays lean (the real long-term token saver).
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne } from "./embeddings";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const LEARN_MODEL =
  process.env.OLLAMA_LEARN_MODEL || process.env.OLLAMA_DISTILL_MODEL || "gemma3";

// Below this cosine similarity a "match" is just noise — don't inject it.
const RECALL_MIN_SIMILARITY = 0.45;
const RECALL_K = 6;

export interface RecalledMemory {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  similarity: number;
}

/** Embed + store one memory. Embedding failure stores the row without a vector
 *  rather than losing the fact (a later backfill/dream can fill it). */
export async function addMemory(opts: {
  content: string;
  category?: string;
  importance?: number;
  sourceMsgId?: string;
}): Promise<void> {
  const content = opts.content.trim();
  if (!content) return;
  let embedding: number[] | null = null;
  try {
    embedding = await embedOne(content);
  } catch (err) {
    console.error(`[memory] embed-on-write failed: ${err instanceof Error ? err.message : err}`);
  }
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("memory").insert({
    content,
    category: opts.category?.trim() || "general",
    importance: Math.max(1, Math.min(10, Math.round(opts.importance ?? 5))),
    ...(opts.sourceMsgId ? { source_msg_id: opts.sourceMsgId } : {}),
    ...(embedding ? { embedding } : {}),
  });
  if (error) {
    // A dimension mismatch here is the classic silent-recall-breaker: the
    // memory.embedding column dim must equal EMBED_DIM. Make it LOUD + actionable
    // instead of swallowing it (the write previously ignored its result).
    const dimHint = /dimension|expected \d+ dimensions/i.test(error.message)
      ? ` — memory.embedding column dim ≠ EMBED_DIM (${embedding?.length ?? "?"}). Re-apply supabase/_apply_all.sql or set EMBED_DIM to match your schema.`
      : "";
    console.error(`[memory] write failed: ${error.message}${dimHint}`);
  }
}

/** Top-K memories relevant to `query`, filtered to meaningful matches. */
export async function recallMemories(query: string, k = RECALL_K): Promise<RecalledMemory[]> {
  const text = query.trim();
  if (!text) return [];
  try {
    const vec = await embedOne(text);
    const supabase = createServiceSupabase();
    const { data, error } = await supabase.rpc("match_memory", {
      query_embedding: vec,
      match_count: k,
      filter_category: null,
    });
    if (error || !Array.isArray(data)) return [];
    return (data as RecalledMemory[]).filter((m) => (m.similarity ?? 0) >= RECALL_MIN_SIMILARITY);
  } catch (err) {
    console.error(`[memory] recall failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Render recalled memories as a compact system-prompt section (or ""). */
export function buildRecallBlock(mems: RecalledMemory[]): string {
  if (mems.length === 0) return "";
  const lines = mems.map((m) => `- ${m.content}`).join("\n");
  return (
    `\n\n## Relevant memories\n` +
    `Long-term facts you've learned that relate to this message. Use them ` +
    `naturally; don't recite them verbatim or mention "my memory".\n${lines}\n`
  );
}

const LEARN_PROMPT = `You extract durable, long-term memories from a single chat exchange for a personal AI assistant.

Keep ONLY facts worth remembering for weeks: the user's identity, preferences, decisions, ongoing projects/goals, relationships, and concrete commitments. IGNORE small talk, transient task details, and anything the assistant merely speculated.

Return STRICT JSON: {"facts":[{"content":"<one sentence>","category":"fact|preference|decision|project|reference","importance":<1-10>}]}
Return {"facts":[]} if nothing is worth keeping. No prose, JSON only.`;

/** Extract durable facts from an exchange via the local model and store them.
 *  Fire-and-forget; swallows all errors. */
export async function learnFromExchange(userMsg: string, assistantReply: string): Promise<void> {
  try {
    const body = {
      model: LEARN_MODEL,
      prompt: `${LEARN_PROMPT}\n\nUser: ${userMsg}\nAssistant: ${assistantReply.slice(0, 4000)}\n\nJSON:`,
      stream: false,
      format: "json",
      options: { temperature: 0 },
    };
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return;
    let parsed: { facts?: Array<{ content?: string; category?: string; importance?: number }> };
    try {
      parsed = JSON.parse(data.response);
    } catch {
      return;
    }
    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 3) : [];
    for (const f of facts) {
      if (typeof f.content === "string" && f.content.trim().length > 3) {
        await addMemory({
          content: f.content,
          category: typeof f.category === "string" ? f.category : "general",
          importance: typeof f.importance === "number" ? f.importance : 5,
        });
      }
    }
  } catch (err) {
    console.error(`[memory] learnFromExchange failed: ${err instanceof Error ? err.message : err}`);
  }
}
