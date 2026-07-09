import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Google OAuth app credentials — set from Settings (no .env edit), stored in
 * app_config, read at runtime. Falls back to the GOOGLE_* env vars. The client
 * secret is never echoed back (only hasSecret). Mirrors ms-graph/creds.ts.
 */
export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const KEY = "google_creds";
let stored: Partial<GoogleCreds> = {};

function resolve(k: keyof GoogleCreds, env: string | undefined): string {
  const s = stored[k];
  if (s && s.trim()) return s.trim();
  return env && env.trim() ? env.trim() : "";
}

export function getGoogleClientId(): string { return resolve("clientId", process.env.GOOGLE_CLIENT_ID); }
export function getGoogleClientSecret(): string { return resolve("clientSecret", process.env.GOOGLE_CLIENT_SECRET); }
export function getGoogleRedirectUri(): string { return resolve("redirectUri", process.env.GOOGLE_REDIRECT_URI); }
export function hasGoogleCreds(): boolean { return !!(getGoogleClientId() && getGoogleClientSecret() && getGoogleRedirectUri()); }

/** Non-secret status for the UI — never returns the client secret. */
export function googleCredsStatus() {
  return {
    clientId: getGoogleClientId(),
    redirectUri: getGoogleRedirectUri(),
    hasSecret: !!getGoogleClientSecret(),
    hasCreds: hasGoogleCreds(),
  };
}

export async function setGoogleCreds(patch: Partial<GoogleCreds>): Promise<void> {
  const next: Partial<GoogleCreds> = { ...stored };
  const set = (k: keyof GoogleCreds, keepOnEmpty: boolean) => {
    const v = patch[k];
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t) next[k] = t;
    else if (!keepOnEmpty) delete next[k];
  };
  set("clientId", false);
  set("redirectUri", false);
  set("clientSecret", true); // blank = leave the stored secret unchanged
  stored = next;
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft: in-memory still applies for this process */
  }
}

export async function hydrateGoogleCreds(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") stored = v as Partial<GoogleCreds>;
    }
  } catch {
    /* fail-soft */
  }
}

void hydrateGoogleCreds();
