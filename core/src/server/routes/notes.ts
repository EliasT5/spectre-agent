import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * /api/notes - user-drafted notes + structured todos. Two kinds in one
 * table: `note` (free-form ideas) and `todo` (deadline + priority +
 * done flag). Distinct from /api/memory (long-term facts).
 *
 * GET supports filtering by kind, search, done state, pinned.
 * POST accepts a `kind` field; todo-specific fields are read only when
 * kind === 'todo'.
 */

const VALID_KINDS = new Set(["note", "todo"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);

export const notes = new Hono();

notes.get("/", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const kind = c.req.query("kind")?.trim() ?? "";
  const done = c.req.query("done");
  const pinned = c.req.query("pinned");
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? 200)));

  const supabase = createServiceSupabase();
  let query = supabase
    .from("notes")
    .select(
      "id, kind, content, pinned, deadline, priority, done, done_at, source_msg_id, source_thread_id, created_at, updated_at",
    )
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) query = query.ilike("content", `%${q}%`);
  if (kind && VALID_KINDS.has(kind)) query = query.eq("kind", kind);
  if (done === "1" || done === "true") query = query.eq("done", true);
  else if (done === "0" || done === "false") query = query.eq("done", false);
  if (pinned === "1" || pinned === "true") query = query.eq("pinned", true);

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  return c.json({ items: data ?? [] });
});

notes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return c.json({ error: "content required" }, 400);
  }

  const kindRaw = typeof body.kind === "string" ? body.kind : "note";
  const kind = VALID_KINDS.has(kindRaw) ? kindRaw : "note";
  const pinned = body.pinned === true;

  let deadline: string | null = null;
  let priority: string | null = null;
  if (kind === "todo") {
    if (typeof body.deadline === "string" && body.deadline) {
      const parsed = new Date(body.deadline);
      if (!Number.isNaN(parsed.getTime())) deadline = parsed.toISOString();
    }
    if (typeof body.priority === "string" && VALID_PRIORITIES.has(body.priority)) {
      priority = body.priority;
    }
  }

  const source_msg_id = typeof body.source_msg_id === "string" ? body.source_msg_id : null;
  const source_thread_id = typeof body.source_thread_id === "string" ? body.source_thread_id : null;

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("notes")
    .insert({ kind, content, pinned, deadline, priority, source_msg_id, source_thread_id })
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

notes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.content === "string") update.content = body.content.trim();
  if (typeof body.pinned === "boolean") update.pinned = body.pinned;
  if (typeof body.priority === "string" && VALID_PRIORITIES.has(body.priority)) {
    update.priority = body.priority;
  } else if (body.priority === null) {
    update.priority = null;
  }
  if (typeof body.deadline === "string" && body.deadline) {
    const parsed = new Date(body.deadline);
    if (!Number.isNaN(parsed.getTime())) update.deadline = parsed.toISOString();
  } else if (body.deadline === null) {
    update.deadline = null;
  }
  if (typeof body.done === "boolean") {
    update.done = body.done;
    update.done_at = body.done ? new Date().toISOString() : null;
  }

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("notes")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

notes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
