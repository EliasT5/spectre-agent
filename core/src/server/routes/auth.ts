import { Hono } from "hono";
import { GRAPH_SCOPES, deleteTokens, getStoredTokens, saveTokens } from "@/lib/ms-graph/client";

// PIN/cookie auth lives entirely in the shell (its /api/auth/pin route + the
// HMAC jerome_session cookie verified by proxy.ts). The core is loopback-only
// behind CORE_TOKEN, and the shell proxy strips cookies, so a core-side cookie
// could never round-trip anyway. This file only keeps the MS Graph OAuth flow.

export const auth = new Hono();

function tokenEndpoint() {
  const tenant = process.env.MS_GRAPH_TENANT_ID || "common";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

interface GraphUser {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

auth.get("/ms-graph/login", (c) => {
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const redirectUri = process.env.MS_GRAPH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return c.json({ error: "MS Graph not configured (set MS_GRAPH_CLIENT_ID and MS_GRAPH_REDIRECT_URI)" }, 503);
  }

  const tenant = process.env.MS_GRAPH_TENANT_ID || "common";
  const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GRAPH_SCOPES);
  authUrl.searchParams.set("response_mode", "query");

  return c.redirect(authUrl.toString(), 302);
});

auth.get("/ms-graph/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code) {
    const msg = url.searchParams.get("error_description") ?? oauthError ?? "No code returned";
    return c.redirect(new URL(`/settings?ms_error=${encodeURIComponent(msg)}`, c.req.url).toString(), 302);
  }

  const params = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID!,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET!,
    code,
    redirect_uri: process.env.MS_GRAPH_REDIRECT_URI!,
    grant_type: "authorization_code",
    scope: GRAPH_SCOPES,
  });

  const tokenRes = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return c.redirect(
      new URL(`/settings?ms_error=${encodeURIComponent(`Token exchange failed: ${body.slice(0, 120)}`)}`, c.req.url).toString(),
      302,
    );
  }

  const json = await tokenRes.json();
  const expiresAt = new Date(Date.now() + (json.expires_in as number) * 1000).toISOString();

  let user: GraphUser = {};
  try {
    const profileRes = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName",
      { headers: { Authorization: `Bearer ${json.access_token as string}` } },
    );
    if (profileRes.ok) user = await profileRes.json();
  } catch {
    // Non-fatal; still save the tokens.
  }

  await saveTokens({
    access_token: json.access_token as string,
    refresh_token: json.refresh_token as string,
    expires_at: expiresAt,
    user_email: user.mail ?? user.userPrincipalName,
    user_name: user.displayName,
  });

  return c.redirect(new URL("/settings?ms_connected=1", c.req.url).toString(), 302);
});

auth.post("/ms-graph/disconnect", async (c) => {
  await deleteTokens();
  return c.json({ ok: true });
});

auth.get("/ms-graph/status", async (c) => {
  const tokens = await getStoredTokens();
  if (!tokens) return c.json({ connected: false });
  return c.json({
    connected: true,
    user_email: tokens.user_email ?? null,
    user_name: tokens.user_name ?? null,
  });
});
