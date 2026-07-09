import { Hono } from "hono";
import { getDangerSettings, setDangerSettings } from "@/lib/danger-settings";
import { featureFlagsStatus, setFeatureFlags } from "@/lib/feature-flags";

/**
 * Settings → Danger Zone toggles. Read the current state and flip individual
 * switches at runtime (stored in app_config) so a self-hoster never edits .env.
 * CORE_TOKEN-gated like all /api/*. Also carries the CLI feature flags (managing
 * CLI brains, and the RCE custom-backends switch) since those are advanced toggles.
 */
export const danger = new Hono();

danger.get("/", (c) => c.json({ ...getDangerSettings(), ...featureFlagsStatus() }));

danger.put("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    allowEnvAccess?: unknown; cliUi?: unknown; cliBackends?: unknown;
  };
  const patch: Parameters<typeof setDangerSettings>[0] = {};
  if (typeof body.allowEnvAccess === "boolean") patch.allowEnvAccess = body.allowEnvAccess;
  await setDangerSettings(patch);

  const ff: Parameters<typeof setFeatureFlags>[0] = {};
  if (typeof body.cliUi === "boolean") ff.cliUi = body.cliUi;
  if (typeof body.cliBackends === "boolean") ff.cliBackends = body.cliBackends;
  if (Object.keys(ff).length) await setFeatureFlags(ff);

  return c.json({ ok: true, ...getDangerSettings(), ...featureFlagsStatus() });
});
