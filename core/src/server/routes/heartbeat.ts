import { Hono } from "hono";
import { runHeartbeat } from "@/lib/ai/heartbeat";
import { runProactiveHeartbeat } from "@/lib/ai/proactive";

export const heartbeat = new Hono();

/** POST /api/heartbeat - trigger a heartbeat cycle */
heartbeat.post("/", async (c) => {
  const result = await runHeartbeat();
  return c.json(result);
});

/** GET /api/heartbeat - check if heartbeat system is configured */
heartbeat.get("/", (c) =>
  c.json({
    enabled: true,
    endpoint: "/api/heartbeat",
    description: "POST to trigger a heartbeat cycle",
  }),
);

/**
 * POST /api/heartbeat/propose
 * Triggers a proactive heartbeat cycle - Haiku decides whether any
 * workshop tasks are worth proposing and writes them into the
 * `workshop_tasks` table with a `[proposal]` title prefix so the worker
 * skips them until a human accepts via UI.
 *
 * Driven by:
 *   - jerome-heartbeat-propose.timer (systemd, every 4h)
 *   - manual curl for debugging
 */
heartbeat.post("/propose", async (c) => {
  const result = await runProactiveHeartbeat();
  return c.json(result);
});
