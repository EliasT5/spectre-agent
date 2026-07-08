import { createServiceSupabase } from "@/lib/supabase/server";
import { getMsGraphClientId, getMsGraphClientSecret, getMsGraphTenant } from "./creds";
import {
  listAccounts,
  updateAccountTokens,
  upsertAccount,
  type ConnectedAccount,
} from "@/lib/accounts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function tokenEndpoint() {
  return `https://login.microsoftonline.com/${getMsGraphTenant()}/oauth2/v2.0/token`;
}

export const GRAPH_SCOPES = "User.Read Calendars.Read Mail.Read offline_access";

interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
}

async function doRefresh(refreshToken: string): Promise<RefreshedTokens> {
  const params = new URLSearchParams({
    client_id: getMsGraphClientId(),
    client_secret: getMsGraphClientSecret(),
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

/** All connected Microsoft accounts. */
export function listMsAccounts(): Promise<ConnectedAccount[]> {
  return listAccounts("microsoft");
}

/** A valid access token for ONE account, refreshing (and persisting) near expiry. */
export async function getValidAccessTokenForAccount(acct: ConnectedAccount): Promise<string> {
  const expMs = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (expMs < Date.now() + 5 * 60 * 1000) {
    const refreshed = await doRefresh(acct.refresh_token);
    await updateAccountTokens(acct.id, refreshed);
    return refreshed.access_token;
  }
  return acct.access_token;
}

/** Graph GET for one account. */
export async function graphFetchForAccount<T>(acct: ConnectedAccount, path: string): Promise<T> {
  const accessToken = await getValidAccessTokenForAccount(acct);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Graph API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * One-time import of the legacy single-account token (app_config 'ms_graph_tokens')
 * into connected_accounts, then delete the legacy key. No-op if absent. Keeps an
 * already-connected account working across the multi-account switch.
 */
export async function migrateLegacyMsToken(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", "ms_graph_tokens").maybeSingle();
    const t = data?.value as
      | { access_token?: string; refresh_token?: string; expires_at?: string; user_email?: string; user_name?: string }
      | null;
    if (!t?.access_token || !t?.refresh_token) return;
    await upsertAccount({
      provider: "microsoft",
      account_email: t.user_email || "microsoft-account",
      account_name: t.user_name ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at ?? null,
      scopes: GRAPH_SCOPES,
    });
    await supabase.from("app_config").delete().eq("key", "ms_graph_tokens");
  } catch {
    /* fail-soft */
  }
}

void migrateLegacyMsToken();
