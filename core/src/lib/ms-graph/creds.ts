import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Microsoft Graph app-registration credentials — set from Settings (no .env
 * edit), stored in app_config, read at runtime. Falls back to the MS_GRAPH_* env
 * vars so existing .env deployments keep working. The client secret is never
 * echoed back (only hasSecret). Mirrors core/src/lib/github-token.ts.
 */
export interface MsGraphCreds {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

const KEY = "ms_graph_creds";
let stored: Partial<MsGraphCreds> = {};

function resolve(k: keyof MsGraphCreds, env: string | undefined): string {
  const s = stored[k];
  if (s && s.trim()) return s.trim();
  return env && env.trim() ? env.trim() : "";
}

export function getMsGraphClientId(): string { return resolve("clientId", process.env.MS_GRAPH_CLIENT_ID); }
export function getMsGraphClientSecret(): string { return resolve("clientSecret", process.env.MS_GRAPH_CLIENT_SECRET); }
export function getMsGraphTenant(): string { return resolve("tenantId", process.env.MS_GRAPH_TENANT_ID) || "common"; }
export function getMsGraphRedirectUri(): string { return resolve("redirectUri", process.env.MS_GRAPH_REDIRECT_URI); }
export function hasMsGraphCreds(): boolean { return !!(getMsGraphClientId() && getMsGraphClientSecret()); }

/** Non-secret status for the UI — never returns the client secret. */
export function msGraphCredsStatus() {
  return {
    clientId: getMsGraphClientId(),
    tenantId: stored.tenantId ?? process.env.MS_GRAPH_TENANT_ID ?? "",
    redirectUri: getMsGraphRedirectUri(),
    hasSecret: !!getMsGraphClientSecret(),
    hasCreds: hasMsGraphCreds(),
  };
}

export async function setMsGraphCreds(patch: Partial<MsGraphCreds>): Promise<void> {
  const next: Partial<MsGraphCreds> = { ...stored };
  const set = (k: keyof MsGraphCreds, keepOnEmpty: boolean) => {
    const v = patch[k];
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t) next[k] = t;
    else if (!keepOnEmpty) delete next[k];
  };
  set("clientId", false);
  set("tenantId", false);
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

export async function hydrateMsGraphCreds(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") stored = v as Partial<MsGraphCreds>;
    }
  } catch {
    /* fail-soft */
  }
}

void hydrateMsGraphCreds();
