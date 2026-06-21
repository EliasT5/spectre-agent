/**
 * Dream consolidation — keeps the memory store lean and high-signal so recall
 * stays cheap as Jerome learns. This is the real long-term token saver: a small,
 * deduped store means the per-turn top-K recall always pulls distinct facts.
 *
 * Three passes (all local, no LLM needed for dedup):
 *   1. BACKFILL — embed any memory still missing a vector (older rows, or rows
 *      whose embed-on-write failed) so they become searchable + dedupable.
 *   2. DEDUP    — collapse near-identical memories (cosine >= threshold) to a
 *      single best representative (highest importance, then longest, then
 *      newest). This closes the "agent memory.add + auto-learner" double-write.
 *   3. DECAY    — prune trivial, stale memories (importance <= 2 and older than
 *      DECAY_DAYS) so noise doesn't accumulate.
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne, embedBatch } from "@/lib/ai/embeddings";

const DEDUP_THRESHOLD = 0.85; // cosine above which two memories are auto-merged (clear dup / light paraphrase)
const LLM_MERGE_LOW = 0.72; // [LLM_MERGE_LOW, DEDUP_THRESHOLD): "maybe the same" — ask the local model
const MAX_LLM_CLUSTERS = 12; // bound the local-model calls per consolidation run
const DECAY_DAYS = 45;
const DECAY_MAX_IMPORTANCE = 2;

// ── Message-embedding backfill (cross-thread recall) ──────────────────────────
// Messages are embedded HERE (the background dream pass), never on the chat
// write path, so sends stay fast. Bound the per-run work + skip noise.
const MSG_BACKFILL_MAX = 400; // cap embeds per nightly run (keeps cost bounded)
const MSG_BACKFILL_BATCH = 50; // embed + write in batches
const MSG_MIN_CHARS = 10; // skip empty / trivial rows
const MSG_MAX_CHARS = 4000; // cap content length sent to the embedder

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const MERGE_MODEL =
  process.env.OLLAMA_LEARN_MODEL || process.env.OLLAMA_DISTILL_MODEL || "gemma3";

/**
 * Ask the local model whether a cluster of similar memories is the SAME
 * underlying fact and, if so, return the single best merged statement.
 * Conservative by design — returns same:false unless they clearly coincide,
 * so distinct-but-related facts are kept separate.
 */
async function llmMerge(statements: string[]): Promise<string | null> {
  const prompt =
    `These memory statements were flagged as possibly the same fact about the user/project:\n` +
    statements.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    `\n\nDo they all express the SAME underlying fact? Only say yes if merging loses no distinct information. ` +
    `Return STRICT JSON: {"same": true|false, "merged": "<single best statement>"}. ` +
    `If not the same, {"same": false, "merged": ""}.`;
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MERGE_MODEL, prompt, stream: false, format: "json", options: { temperature: 0 } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;
    const parsed = JSON.parse(data.response) as { same?: boolean; merged?: string };
    if (parsed.same === true && typeof parsed.merged === "string" && parsed.merged.trim().length > 3) {
      return parsed.merged.trim();
    }
    return null;
  } catch {
    return null;
  }
}

interface MemRow {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  embedding: unknown;
  created_at: string;
}

function parseEmbedding(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Which of two near-duplicate memories to keep. */
function isBetter(a: MemRow, b: MemRow): boolean {
  const ia = a.importance ?? 5;
  const ib = b.importance ?? 5;
  if (ia !== ib) return ia > ib;
  if (a.content.length !== b.content.length) return a.content.length > b.content.length;
  return a.created_at >= b.created_at; // newer wins ties
}

export interface MessageBackfillResult {
  scanned: number; // rows lacking an embedding that qualified for backfill
  embedded: number; // rows successfully embedded + written
  skipped: number; // qualified rows skipped (embed error, etc.)
  dryRun: boolean;
}

/**
 * Embed past messages that still lack a vector, so cross-thread recall can find
 * them. Runs in the nightly dream pass — NOT the chat write path — and is
 * bounded per run (MSG_BACKFILL_MAX) so it never blocks or balloons.
 *
 * Only real conversation turns are embedded: role in (user, assistant), content
 * present and >= MSG_MIN_CHARS. Content is clipped to MSG_MAX_CHARS. The SQL
 * `match_messages` RPC additionally filters role at query time, so even if a
 * stray row slips through it won't surface.
 */
export async function backfillMessageEmbeddings(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<MessageBackfillResult> {
  const dryRun = opts.dryRun === true;
  const max = Math.max(1, opts.max ?? MSG_BACKFILL_MAX);
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("messages")
    .select("id, content")
    .is("embedding", null)
    .in("role", ["user", "assistant"])
    .not("content", "is", null)
    .order("created_at", { ascending: false }) // recent conversations first
    .limit(max);
  if (error) throw new Error(`message-backfill: ${error.message}`);

  const rows = ((data ?? []) as Array<{ id: string; content: string | null }>)
    .map((r) => ({ id: r.id, content: (r.content ?? "").trim() }))
    .filter((r) => r.content.length >= MSG_MIN_CHARS);

  let embedded = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += MSG_BACKFILL_BATCH) {
    const batch = rows.slice(i, i + MSG_BACKFILL_BATCH);
    let vectors: number[][];
    try {
      vectors = await embedBatch(batch.map((r) => r.content.slice(0, MSG_MAX_CHARS)));
    } catch (err) {
      // A whole-batch embed failure shouldn't abort the run — skip + continue.
      console.error(
        `[message-backfill] batch embed failed: ${err instanceof Error ? err.message : err}`,
      );
      skipped += batch.length;
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      const vec = vectors[j];
      if (!Array.isArray(vec) || vec.length === 0) {
        skipped++;
        continue;
      }
      if (!dryRun) {
        const { error: upErr } = await supabase
          .from("messages")
          .update({ embedding: vec })
          .eq("id", batch[j].id);
        if (upErr) {
          skipped++;
          continue;
        }
      }
      embedded++;
    }
  }

  return { scanned: rows.length, embedded, skipped, dryRun };
}

export interface ConsolidateResult {
  total: number;
  backfilled: number;
  duplicatesRemoved: number;
  llmMerged: number;
  decayed: number;
  merges: Array<{ kept: string; dropped: string; sim: number }>;
  messageBackfill: MessageBackfillResult;
  dryRun: boolean;
}

export async function consolidateMemories(
  opts: { dryRun?: boolean } = {},
): Promise<ConsolidateResult> {
  const dryRun = opts.dryRun === true;
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("memory")
    .select("id, content, category, importance, embedding, created_at");
  if (error) throw new Error(`consolidate: ${error.message}`);
  const rows = (data ?? []) as MemRow[];

  // 1. BACKFILL missing embeddings.
  let backfilled = 0;
  for (const r of rows) {
    if (parseEmbedding(r.embedding)) continue;
    try {
      const vec = await embedOne(r.content);
      r.embedding = vec;
      backfilled++;
      if (!dryRun) await supabase.from("memory").update({ embedding: vec }).eq("id", r.id);
    } catch {
      /* leave unembedded; it just won't dedupe this round */
    }
  }

  // 2. DEDUP via pairwise cosine (fine for a personal-scale store).
  const items = rows
    .map((r) => ({ row: r, vec: parseEmbedding(r.embedding) }))
    .filter((x): x is { row: MemRow; vec: number[] } => x.vec !== null);

  const removed = new Set<string>();
  const merges: ConsolidateResult["merges"] = [];
  for (let i = 0; i < items.length; i++) {
    if (removed.has(items[i].row.id)) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (removed.has(items[j].row.id)) continue;
      const sim = cosine(items[i].vec, items[j].vec);
      if (sim < DEDUP_THRESHOLD) continue;
      const keepI = isBetter(items[i].row, items[j].row);
      const keep = keepI ? items[i].row : items[j].row;
      const drop = keepI ? items[j].row : items[i].row;
      removed.add(drop.id);
      merges.push({
        kept: keep.content.slice(0, 60),
        dropped: drop.content.slice(0, 60),
        sim: Number(sim.toFixed(3)),
      });
      if (drop.id === items[i].row.id) break; // i itself was dropped
    }
  }
  if (!dryRun && removed.size > 0) {
    await supabase.from("memory").delete().in("id", [...removed]);
  }

  // 2b. LLM MERGE — paraphrase clusters the embedding threshold missed. Pairs in
  // the "maybe same" band are union-find clustered; the local model decides if a
  // cluster is one fact and returns the merged statement (conservative).
  let llmMerged = 0;
  const survivors = items.filter((x) => !removed.has(x.row.id));
  const parent = new Map<string, string>(survivors.map((s) => [s.row.id, s.row.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      const sim = cosine(survivors[i].vec, survivors[j].vec);
      if (sim >= LLM_MERGE_LOW && sim < DEDUP_THRESHOLD) {
        union(survivors[i].row.id, survivors[j].row.id);
      }
    }
  }
  const clusters = new Map<string, MemRow[]>();
  for (const s of survivors) {
    const root = find(s.row.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(s.row);
  }
  const candidates = [...clusters.values()].filter((c) => c.length >= 2).slice(0, MAX_LLM_CLUSTERS);
  for (const cluster of candidates) {
    const merged = await llmMerge(cluster.map((m) => m.content));
    if (!merged) continue;
    const keeper = cluster.reduce((best, m) => (isBetter(m, best) ? m : best), cluster[0]);
    const drops = cluster.filter((m) => m.id !== keeper.id);
    llmMerged += drops.length;
    merges.push({ kept: merged.slice(0, 60), dropped: `${drops.length} paraphrase(s)`, sim: 0 });
    drops.forEach((d) => removed.add(d.id));
    if (!dryRun) {
      let mvec: number[] | null = null;
      try {
        mvec = await embedOne(merged);
      } catch {
        /* keep old embedding if re-embed fails */
      }
      await supabase
        .from("memory")
        .update({ content: merged, ...(mvec ? { embedding: mvec } : {}) })
        .eq("id", keeper.id);
      await supabase.from("memory").delete().in("id", drops.map((d) => d.id));
    }
  }

  // 3. DECAY trivial + stale survivors.
  const decayCutoff = new Date(Date.now() - DECAY_DAYS * 86_400_000).toISOString();
  const decayIds = rows
    .filter(
      (r) =>
        !removed.has(r.id) &&
        (r.importance ?? 5) <= DECAY_MAX_IMPORTANCE &&
        r.created_at < decayCutoff,
    )
    .map((r) => r.id);
  if (!dryRun && decayIds.length > 0) {
    await supabase.from("memory").delete().in("id", decayIds);
  }

  // 4. CROSS-THREAD MESSAGE BACKFILL — embed past messages still missing a
  // vector so message recall works. Independent of memory consolidation; a
  // failure here must not lose the memory work above, so it's isolated.
  let messageBackfill: MessageBackfillResult = {
    scanned: 0,
    embedded: 0,
    skipped: 0,
    dryRun,
  };
  try {
    messageBackfill = await backfillMessageEmbeddings({ dryRun });
  } catch (err) {
    console.error(
      `[consolidate] message backfill failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  return {
    total: rows.length,
    backfilled,
    duplicatesRemoved: removed.size - llmMerged,
    llmMerged,
    decayed: decayIds.length,
    merges,
    messageBackfill,
    dryRun,
  };
}
