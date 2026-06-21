import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createServiceSupabase } from "@/lib/supabase/server";
import { runIngest, IngestError } from "@/lib/ingest";

/**
 * Ingest - the active/bidirectional channel. A module PUSHES a signal in
 * (sensor reading, observation, anything) and the core can react:
 *   - store it (always) in ingest_events,
 *   - remember it (-> long-term memory),
 *   - notify the user (-> web push, proactive),
 *   - enqueue a Jerome turn (-> the durable chat-runner runs the full brain on
 *     the signal + instruction; Jerome can then notify/act with its own tools).
 *
 * Generic by design: any module (a water-reminder, a sensor, a webcam wrapper
 * that pre-describes a frame, ...) builds on this; the core ships no module.
 *
 * The pipeline itself lives in `@/lib/ingest` (runIngest) so the module
 * capability shim (ctx.ingest) shares ONE implementation; this route is a thin
 * HTTP wrapper with identical behavior.
 */

export const ingest = new Hono();

ingest.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await runIngest(body ?? {});
    return c.json(result);
  } catch (e) {
    if (e instanceof IngestError) {
      return c.json({ error: e.code }, e.status as ContentfulStatusCode);
    }
    return c.json({ error: "ingest_error" }, 500);
  }
});

/** Recent ingest signals (for modules / Jerome to review). */
ingest.get("/", async (c) => {
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("ingest_events")
    .select("id, module, kind, summary, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ events: data ?? [] });
});
