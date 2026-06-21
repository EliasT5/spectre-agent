import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne } from "@/lib/ai/embeddings";

/**
 * /api/memory - long-term recall store backed by `memory` table.
 *
 * Semantic by default: new entries are embedded on write (local Ollama
 * embedder), and `?q=` runs cosine similarity via the `match_memory` RPC so
 * recall is by *meaning*, not substring. Falls back to text `ilike` if the
 * embedder is unavailable, so the store never hard-fails on a missing model.
 */

export const memory = new Hono();

memory.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const category = c.req.query("category")?.trim() ?? "";
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? 200)));

  const supabase = createServiceSupabase();

  const catsPromise = supabase
    .from("memory")
    .select("category")
    .not("category", "is", null);

  if (q) {
    try {
      const qvec = await embedOne(q);
      const { data, error } = await supabase.rpc("match_memory", {
        query_embedding: qvec,
        match_count: limit,
        filter_category: category || null,
      });
      if (!error && Array.isArray(data)) {
        const { data: catRows } = await catsPromise;
        const categories = [
          ...new Set((catRows ?? []).map((r: { category: string }) => r.category)),
        ].sort();
        return c.json({ items: data, categories, mode: "semantic" });
      }
      // RPC failed (e.g. no embeddings yet) - fall through to text search.
    } catch (err) {
      console.error(`[memory] semantic search failed, falling back to text: ${err instanceof Error ? err.message : err}`);
    }
  }

  let query = supabase
    .from("memory")
    .select("id, content, category, source_msg_id, importance, last_accessed, created_at")
    .order("importance", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) query = query.ilike("content", `%${q}%`);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  const { data: catRows } = await catsPromise;
  const categories = [
    ...new Set((catRows ?? []).map((r: { category: string }) => r.category)),
  ].sort();

  return c.json({ items: data ?? [], categories, mode: q ? "text" : "list" });
});

memory.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return c.json({ error: "content required" }, 400);
  }
  const category =
    typeof body.category === "string" && body.category.trim() ? body.category.trim() : "general";
  const importance = Number.isFinite(body.importance)
    ? Math.max(1, Math.min(10, Math.round(body.importance)))
    : 5;

  // Embed on write so the memory is semantically recallable. A failed embed
  // must NOT lose the memory - store it without a vector and let a later
  // dream/backfill pass fill it in.
  let embedding: number[] | null = null;
  try {
    embedding = await embedOne(content);
  } catch (err) {
    console.error(`[memory] embed-on-write failed (stored without vector): ${err instanceof Error ? err.message : err}`);
  }

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("memory")
    .insert({ content, category, importance, ...(embedding ? { embedding } : {}) })
    .select("id, content, category, importance, created_at")
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

memory.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  if (typeof body.content === "string" && body.content.trim()) patch.content = body.content.trim();
  if (typeof body.category === "string" && body.category.trim()) patch.category = body.category.trim();
  if (Number.isFinite(body.importance)) {
    patch.importance = Math.max(1, Math.min(10, Math.round(body.importance)));
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("memory")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

memory.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("memory").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
