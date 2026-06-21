import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";

export const storage = new Hono();

/** POST /api/storage/purge-archive - hard-deletes archived threads (cascades messages). */
storage.post("/purge-archive", async (c) => {
  const supabase = createServiceSupabase();
  const { error, count } = await supabase
    .from("threads")
    .delete({ count: "exact" })
    .eq("archived", true);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ deleted: count ?? 0 });
});

storage.get("/stats", async (c) => {
  const supabase = createServiceSupabase();

  const tables = ["threads", "messages", "memory", "workshop_tasks", "voice_sessions", "uploads"] as const;
  const counts: Record<string, number> = {};

  await Promise.all(
    tables.map(async (t) => {
      const { count } = await supabase.from(t).select("*", { count: "exact", head: true });
      counts[t] = count ?? 0;
    }),
  );

  // Archived threads - useful for the "purge archive" button on Settings.
  const { count: archivedCount } = await supabase
    .from("threads")
    .select("*", { count: "exact", head: true })
    .eq("archived", true);

  return c.json({ counts, archivedThreads: archivedCount ?? 0 });
});
