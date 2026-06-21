import { createServiceSupabase } from "@/lib/supabase/server";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function tokenEndpoint() {
  const tenant = process.env.MS_GRAPH_TENANT_ID || "common";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export const GRAPH_SCOPES = "User.Read Calendars.Read offline_access";

export interface MsGraphTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO timestamp
  user_email?: string;
  user_name?: string;
}

export async function getStoredTokens(): Promise<MsGraphTokens | null> {
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ms_graph_tokens")
    .maybeSingle();
  return (data?.value as MsGraphTokens | null) ?? null;
}

export async function saveTokens(tokens: MsGraphTokens): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase
    .from("app_config")
    .upsert(
      { key: "ms_graph_tokens", value: tokens, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
}

export async function deleteTokens(): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase.from("app_config").delete().eq("key", "ms_graph_tokens");
}

async function doRefresh(refreshToken: string): Promise<Omit<MsGraphTokens, "user_email" | "user_name">> {
  const params = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID!,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET!,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    scope: GRAPH_SCOPES,
  });
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string | undefined) ?? refreshToken,
    expires_at: new Date(Date.now() + (json.expires_in as number) * 1000).toISOString(),
  };
}

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = await getStoredTokens();
  if (!tokens) return null;

  // Refresh 5 minutes before expiry
  if (new Date(tokens.expires_at).getTime() < Date.now() + 5 * 60 * 1000) {
    const refreshed = await doRefresh(tokens.refresh_token);
    await saveTokens({ ...refreshed, user_email: tokens.user_email, user_name: tokens.user_name });
    return refreshed.access_token;
  }
  return tokens.access_token;
}

export async function graphFetch<T>(path: string): Promise<T> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error("Microsoft 365 not connected");
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}
