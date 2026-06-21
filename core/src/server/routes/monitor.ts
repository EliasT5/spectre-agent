import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { reportEvent, type Severity } from "@/lib/monitor/report";

export const monitor = new Hono();

monitor.get("/", async (c) => {
  const supabase = createServiceSupabase();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const severity = c.req.query("severity"); // filter: info | warning | critical

  let query = supabase
    .from("monitor_events")
    .select("id, created_at, severity, component, description, action_taken, action_result")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (severity) query = query.eq("severity", severity);

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // Summary: last event per component, plus counts
  const latest = data?.[0] ?? null;
  const warnings = data?.filter((e: { severity: string }) => e.severity === "warning").length ?? 0;
  const criticals = data?.filter((e: { severity: string }) => e.severity === "critical").length ?? 0;

  return c.json({ summary: { latest, warnings, criticals }, events: data });
});

/**
 * Ingest a debug event from anywhere - core routes, the chat-runner, the worker,
 * the MCP broker. Behind the CORE_TOKEN gate. Body: { severity, component,
 * description, detail?, threadId?, push? }.
 */
monitor.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { severity, component, description, detail, threadId, push } = body ?? {};
  if (!severity || !component || !description) {
    return c.json({ error: "severity, component, description required" }, 400);
  }
  await reportEvent({
    severity: severity as Severity,
    component: String(component),
    description: String(description),
    detail,
    threadId: typeof threadId === "string" ? threadId : undefined,
    push: push === true,
  });
  return c.json({ ok: true });
});
