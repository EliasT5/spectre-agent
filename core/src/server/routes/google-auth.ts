import { Hono } from "hono";
import { GOOGLE_SCOPES } from "@/lib/google/client";
import { listAccounts, removeAccount, upsertAccount } from "@/lib/accounts";
import {
  getGoogleClientId,
  getGoogleClientSecret,
  getGoogleRedirectUri,
  googleCredsStatus,
  setGoogleCreds,
} from "@/lib/google/creds";

/**
 * Google OAuth (calendar, read-only) — multi-account. Mirrors the Microsoft flow
 * in routes/auth.ts: connect ADDS an account (keyed by email), disconnect removes
 * one by id, status returns the list. Tokens live in connected_accounts.
 */
export const googleAuth = new Hono();

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface GoogleUserInfo {
  email?: string;
  name?: string;
}

googleAuth.get("/google/login", (c) => {
  const clientId = getGoogleClientId();
  const redirectUri = getGoogleRedirectUri();
  if (!clientId || !redirectUri) {
    return c.redirect(
      new URL(`/settings?google_error=${encodeURIComponent("Set the Google app credentials in Settings first.")}`, c.req.url).toString(),
      302,
    );
  }

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline"); // get a refresh token
  // consent forces a refresh token even on re-auth; select_account lets you add a
  // DIFFERENT account.
  authUrl.searchParams.set("prompt", "consent select_account");

  return c.redirect(authUrl.toString(), 302);
});

googleAuth.get("/google/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code) {
    const msg = url.searchParams.get("error_description") ?? oauthError ?? "No code returned";
    return c.redirect(new URL(`/settings?google_error=${encodeURIComponent(msg)}`, c.req.url).toString(), 302);
  }

  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    code,
    redirect_uri: getGoogleRedirectUri(),
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return c.redirect(
      new URL(`/settings?google_error=${encodeURIComponent(`Token exchange failed: ${body.slice(0, 120)}`)}`, c.req.url).toString(),
      302,
    );
  }

  const json = await tokenRes.json();
  const expiresAt = new Date(Date.now() + (json.expires_in as number) * 1000).toISOString();

  // Without offline consent Google omits the refresh token; we can't keep the
  // account working past the first hour, so treat that as an error.
  const refreshToken = json.refresh_token as string | undefined;
  if (!refreshToken) {
    return c.redirect(
      new URL(`/settings?google_error=${encodeURIComponent("Google did not return a refresh token. Remove Spectre's access in your Google account and reconnect.")}`, c.req.url).toString(),
      302,
    );
  }

  let user: GoogleUserInfo = {};
  try {
    const profileRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${json.access_token as string}` },
    });
    if (profileRes.ok) user = await profileRes.json();
  } catch {
    // Non-fatal; still save if we can identify the account.
  }

  const email = user.email;
  if (!email) {
    return c.redirect(
      new URL(`/settings?google_error=${encodeURIComponent("Could not read the account email from Google.")}`, c.req.url).toString(),
      302,
    );
  }

  await upsertAccount({
    provider: "google",
    account_email: email,
    account_name: user.name ?? null,
    access_token: json.access_token as string,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    scopes: GOOGLE_SCOPES,
  });

  return c.redirect(new URL("/settings?google_connected=1", c.req.url).toString(), 302);
});

googleAuth.post("/google/disconnect", async (c) => {
  const { id } = (await c.req.json().catch(() => ({}))) as { id?: string };
  if (!id) return c.json({ error: "account id required" }, 400);
  await removeAccount(id);
  return c.json({ ok: true });
});

googleAuth.get("/google/status", async (c) => {
  const accounts = await listAccounts("google");
  return c.json({
    connected: accounts.length > 0,
    accounts: accounts.map((a) => ({ id: a.id, user_email: a.account_email, user_name: a.account_name })),
  });
});

// App credentials, settable from Settings (no .env edit). The client secret is
// never returned — only hasSecret.
googleAuth.get("/google/creds", (c) => c.json(googleCredsStatus()));

googleAuth.put("/google/creds", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    clientId: string; clientSecret: string; redirectUri: string;
  }>;
  await setGoogleCreds(body);
  return c.json({ ok: true, ...googleCredsStatus() });
});
