import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";

// Public liveness + READINESS probe. Mounted at /api/health (the only unauth route).
// Beyond "the process is up", it verifies the things a fresh install gets wrong:
// the DB is reachable AND the schema is applied (the durable-chat `messages.status`
// column), and the model gateway answers. Returns 503 when NOT ready so the
// installer's health-check can't show a false-green over an empty database.
export const health = new Hono();

health.get("/", async (c) => {
  const checks: Record<string, string> = {};
  let ready = true;

  // DB + schema: one cheap query that needs both the table and the migration column.
  try {
    const supabase = createServiceSupabase();
    const { error } = await supabase.from("messages").select("status").limit(1);
    if (error) {
      ready = false;
      checks.schema = /column .*status/i.test(error.message)
        ? "missing (run supabase/_apply_all.sql)"
        : /relation|does not exist|schema cache/i.test(error.message)
          ? "not applied (run supabase/_apply_all.sql)"
          : "error";
    } else {
      checks.schema = "ok";
    }
  } catch {
    ready = false;
    checks.db = "unreachable (check Supabase URL + service-role key)";
  }

  // Model gateway: informational (a down gateway is degraded, not dead).
  if (process.env.SPECTRE_LITELLM_URL) {
    try {
      const r = await fetch(`${process.env.SPECTRE_LITELLM_URL}/models`, {
        headers: { Authorization: `Bearer ${process.env.SPECTRE_LITELLM_KEY || ""}` },
        signal: AbortSignal.timeout(2500),
      });
      checks.gateway = r.ok ? "ok" : `http ${r.status}`;
    } catch {
      checks.gateway = "unreachable";
    }
  }

  return c.json(
    { ok: ready, ready, coreApiVersion: 1, runtime: "hono+bun", checks },
    ready ? 200 : 503,
  );
});
