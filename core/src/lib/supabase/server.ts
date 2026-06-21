// NOTE: the cookie-based SSR client (createServerSupabase) was removed — it was
// unused, and its `next/headers` import would pull Next into the bun-compiled
// core binary. The headless core authenticates via CORE_TOKEN, not cookies, so it
// only ever needs the service-role client below. This module is now Next-free.
import { createClient } from "@supabase/supabase-js";

export function createServiceSupabase() {
  // Prefer the server-side SUPABASE_URL over the browser's NEXT_PUBLIC_SUPABASE_URL.
  // For cloud they're identical; for the LOCAL self-hosted DB they differ — the core
  // reaches the gateway server-side (e.g. http://host.docker.internal:8000 / http://kong:8000)
  // while the browser uses http://localhost:8000.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Fail LOUD with a clear cause instead of building a client with `undefined`,
  // which only surfaces later as an opaque URL-parse / auth error at request time.
  if (!url) throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set — the core cannot reach its database.");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set — the core cannot reach its database.");
  return createClient(url, key);
}
