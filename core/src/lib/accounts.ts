import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Connected mail/calendar accounts (Microsoft + Google), multi-account. One row
 * per account in the connected_accounts table (see core/supabase/connected_accounts.sql).
 * Provider-agnostic CRUD; each connector (ms-graph, google) owns its own OAuth +
 * token-refresh logic and uses this store to persist/read accounts.
 */
export type Provider = "microsoft" | "google";

export interface ConnectedAccount {
  id: string;
  provider: Provider;
  account_email: string;
  account_name: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string | null;
  scopes: string | null;
}

const COLS = "id, provider, account_email, account_name, access_token, refresh_token, expires_at, scopes";

export async function listAccounts(provider?: Provider): Promise<ConnectedAccount[]> {
  const supabase = createServiceSupabase();
  let q = supabase.from("connected_accounts").select(COLS).order("created_at", { ascending: true });
  if (provider) q = q.eq("provider", provider);
  const { data } = await q;
  return (data as ConnectedAccount[] | null) ?? [];
}

export async function getAccount(id: string): Promise<ConnectedAccount | null> {
  const supabase = createServiceSupabase();
  const { data } = await supabase.from("connected_accounts").select(COLS).eq("id", id).maybeSingle();
  return (data as ConnectedAccount | null) ?? null;
}

export interface UpsertAccountInput {
  provider: Provider;
  account_email: string;
  account_name?: string | null;
  access_token: string;
  refresh_token: string;
  expires_at?: string | null;
  scopes?: string | null;
}

/** Add a new account, or update the existing one with the same provider + email. */
export async function upsertAccount(input: UpsertAccountInput): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase.from("connected_accounts").upsert(
    {
      provider: input.provider,
      account_email: input.account_email,
      account_name: input.account_name ?? null,
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      expires_at: input.expires_at ?? null,
      scopes: input.scopes ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,account_email" },
  );
}

/** Persist refreshed tokens for one account (by id). */
export async function updateAccountTokens(
  id: string,
  tokens: { access_token: string; refresh_token: string; expires_at: string | null },
): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase
    .from("connected_accounts")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

export async function removeAccount(id: string): Promise<void> {
  const supabase = createServiceSupabase();
  await supabase.from("connected_accounts").delete().eq("id", id);
}
