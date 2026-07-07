import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";

// EXEMPLAR (dynamic param + CRUD + Supabase). Port of
// src/app/api/app-config/[key]/route.ts. `[key]` -> `:key` -> c.req.param("key").
export const appConfig = new Hono();

// Deny-by-default allowlist. `app_config` is a generic KV table that ALSO holds
// secrets written server-side (e.g. `ms_graph_tokens` = MS Graph access+refresh
// tokens). A generic HTTP reader over it would leak those, so this public route
// may only touch the handful of user-facing settings the shell actually uses.
// Anything else (credentials, internal keys) stays reachable only via the
// server-side service client. To add a new setting, add its key here.
// orchestrate   : "1" = enable dispatch_to_model for non-Jerome brains | "" = off
// orchestration_targets : comma-separated dispatchable model IDs; "" / absent = all
const PUBLIC_CONFIG_KEYS = new Set([
  "default_model",
  "approval_mode",
  "blob_layout",
  "orchestrate",
  "orchestration_targets",
  "reasoning_effort",
  // User-defined model display-name overrides for the picker: { "<model id>": "Name" }.
  "model_labels",
]);

appConfig.get("/:key", async (c) => {
  const key = c.req.param("key");
  if (!PUBLIC_CONFIG_KEYS.has(key)) return c.json({ error: "unknown config key" }, 404);
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("app_config")
    .select("value, updated_at")
    .eq("key", key)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ key, value: data?.value ?? null, updated_at: data?.updated_at ?? null });
});

appConfig.put("/:key", async (c) => {
  const key = c.req.param("key");
  if (!PUBLIC_CONFIG_KEYS.has(key)) return c.json({ error: "unknown config key" }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!("value" in body)) return c.json({ error: "value required" }, 400);
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("app_config")
    .upsert({ key, value: body.value, updated_at: new Date().toISOString() }, { onConflict: "key" })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

appConfig.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (!PUBLIC_CONFIG_KEYS.has(key)) return c.json({ error: "unknown config key" }, 404);
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("app_config").delete().eq("key", key);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
