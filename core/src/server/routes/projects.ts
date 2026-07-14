import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Categories for the chat tab. A "category" is a row in the existing `projects`
 * table (name + description + color); a chat belongs to one via
 * `threads.project_id`, and "Uncategorized" is simply `project_id IS NULL`.
 *
 * The `description` is the user's "what belongs here" text — stored now so a
 * future background task can auto-sort chats into categories; nothing consumes
 * it yet. The browser never touches storage: this rides the PIN-gated proxy as
 * /api/projects (mounted in main.ts alongside the other route groups).
 */
export const projects = new Hono();

const DEFAULT_COLOR = "#6366f1";

/** Only the columns the chat tab needs — never leak internal metadata. */
const COLS = "id, name, description, color, active, created_at" as const;

projects.get("/", async (c) => {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("projects")
    .select(COLS)
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data ?? []);
});

projects.post("/", async (c) => {
  const supabase = createServiceSupabase();
  const body = await c.req.json().catch(() => ({}));

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name required" }, 400);

  const row = {
    name,
    description: typeof body?.description === "string" ? body.description.trim() : null,
    color: typeof body?.color === "string" && body.color.trim() ? body.color.trim() : DEFAULT_COLOR,
    active: true,
  };

  const { data, error } = await supabase.from("projects").insert(row).select(COLS).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

projects.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const body = await c.req.json().catch(() => ({}));

  // Whitelist the mutable columns — a raw PATCH must not touch id/created_at.
  const update: Record<string, unknown> = {};
  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    update.name = name;
  }
  if (typeof body?.description === "string") update.description = body.description.trim() || null;
  if (typeof body?.color === "string" && body.color.trim()) update.color = body.color.trim();
  if (typeof body?.active === "boolean") update.active = body.active;

  if (Object.keys(update).length === 0) {
    return c.json({ error: "nothing to update" }, 400);
  }

  const { data, error } = await supabase.from("projects").update(update).eq("id", id).select(COLS).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// Delete a category. Chats are never lost: first re-home this category's threads
// to Uncategorized (project_id -> null), THEN remove the category row, so the
// "Uncategorized ≡ project_id IS NULL" invariant stays clean (no orphan ids).
projects.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();

  const { error: rehomeErr } = await supabase
    .from("threads")
    .update({ project_id: null })
    .eq("project_id", id);
  if (rehomeErr) return c.json({ error: rehomeErr.message }, 500);

  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
