import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { sendPush } from "@/lib/notify";
import { getVapidPublicKey } from "@/lib/vapid";

export const push = new Hono();

push.get("/vapid-public-key", (c) => {
  const key = getVapidPublicKey();
  if (!key) {
    return c.json({ error: "VAPID not configured" }, 503);
  }
  return c.json({ key });
});

push.post("/subscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { endpoint, keys } = body as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: "Invalid subscription object" }, 400);
  }

  const supabase = createServiceSupabase();
  const { error } = await supabase.from("push_subscriptions").upsert(
    { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    { onConflict: "endpoint" },
  );

  if (error) {
    return c.json({ error: error.message }, 500);
  }
  return c.json({ ok: true });
});

push.delete("/subscribe", async (c) => {
  const { endpoint } = (await c.req.json().catch(() => ({}))) as { endpoint: string };
  if (!endpoint) {
    return c.json({ error: "endpoint required" }, 400);
  }

  const supabase = createServiceSupabase();
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  return c.json({ ok: true });
});

// Internal endpoint. Protected by the global CORE_TOKEN gate (coreAuth, applied
// to all /api/* in main.ts) — not by loopback binding. Callers (workers) reach it
// through the core with the core token; no separate service-token check needed.
push.post("/send", async (c) => {
  const { title, body, url } = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    url?: string;
  };

  if (!title || !body) {
    return c.json({ error: "title and body required" }, 400);
  }

  await sendPush({ title, body, url });
  return c.json({ ok: true });
});
