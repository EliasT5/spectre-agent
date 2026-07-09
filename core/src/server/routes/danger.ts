import { Hono } from "hono";
import { getDangerSettings, setDangerSettings } from "@/lib/danger-settings";

/**
 * Settings → Danger Zone toggles. Read the current state and flip individual
 * switches at runtime (stored in app_config). CORE_TOKEN-gated like all /api/*.
 */
export const danger = new Hono();

danger.get("/", (c) => c.json(getDangerSettings()));

danger.put("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { allowEnvAccess?: unknown };
  const patch: Parameters<typeof setDangerSettings>[0] = {};
  if (typeof body.allowEnvAccess === "boolean") patch.allowEnvAccess = body.allowEnvAccess;
  await setDangerSettings(patch);
  return c.json({ ok: true, ...getDangerSettings() });
});
