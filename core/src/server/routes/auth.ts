import { Hono } from "hono";
import { GRAPH_SCOPES } from "@/lib/ms-graph/client";
import { listAccounts, removeAccount, upsertAccount } from "@/lib/accounts";
import {
  getMsGraphClientId,
  getMsGraphClientSecret,
  getMsGraphRedirectUri,
  getMsGraphTenant,
  msGraphCredsStatus,
  setMsGraphCreds,
} from "@/lib/ms-graph/creds";

// PIN/cookie auth lives entirely in the shell (its /api/auth/pin route + the
// HMAC jerome_session cookie verified by proxy.ts). The core is loopback-only
// behind CORE_TOKEN, and the shell proxy strips cookies, so a core-side cookie
// could never round-trip anyway. This file only keeps the MS Graph OAuth flow.

export const auth = new Hono();

function tokenEndpoint() {
  return `https://login.microsoftonline.com/${getMsGraphTenant()}/oauth2/v2.0/token`;
}

interface GraphUser {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

auth.get("/ms-graph/login", (c) => {
  const clientId = getMsGraphClientId();
  const redirectUri = getMsGraphRedirectUri();
  if (!clientId || !redirectUri) {
    return c.redirect(
      new URL(`/settings?ms_error=${encodeURIComponent("Set the Microsoft 365 app credentials in Settings first.")}`, c.req.url).toString(),
      302,
    );
  }

  const authUrl = new URL(`https://login.microsoftonline.com/${getMsGraphTenant()}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GRAPH_SCOPES);
  authUrl.searchParams.set("response_mode", "query");
  // Force the account picker so a user can ADD a different account (otherwise
  // Microsoft silently re-signs-in the last one).
  authUrl.searchParams.set("prompt", "select_account");

  return c.redirect(authUrl.toString(), 302);
});

// ── One-click sign-in: Microsoft device-code flow ──────────────────────────
// No redirect URI, no client secret — works on any self-hosted instance. Uses a
// shipped public client by default (Microsoft Graph Command Line Tools, shown as
// the authorizing app), so a user can connect with zero app setup; override with
// SPECTRE_MS_CLIENT_ID or by saving your own app's Client ID in Settings.
const DEFAULT_MS_DEVICE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
function msDeviceClientId(): string {
  return process.env.SPECTRE_MS_CLIENT_ID || getMsGraphClientId() || DEFAULT_MS_DEVICE_CLIENT_ID;
}
const msDeviceSessions = new Map<string, { deviceCode: string; expiresAt: number; tenant: string; clientId: string }>();

auth.post("/ms-graph/device/start", async (c) => {
  const clientId = msDeviceClientId();
  const tenant = getMsGraphTenant();
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: GRAPH_SCOPES }),
    });
    const j = (await r.json()) as {
      device_code?: string; user_code?: string; verification_uri?: string;
      interval?: number; expires_in?: number; error?: string; error_description?: string;
    };
    if (!r.ok || !j.device_code) {
      return c.json({ error: j.error_description || j.error || `Device start failed (HTTP ${r.status}).` }, 502);
    }
    const sessionId = crypto.randomUUID();
    msDeviceSessions.set(sessionId, {
      deviceCode: j.device_code,
      expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
      tenant,
      clientId,
    });
    return c.json({ sessionId, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval ?? 5 });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

auth.post("/ms-graph/device/poll", async (c) => {
  const { sessionId } = (await c.req.json().catch(() => ({}))) as { sessionId?: string };
  const sess = sessionId ? msDeviceSessions.get(sessionId) : undefined;
  if (!sessionId || !sess) return c.json({ status: "expired" });
  if (Date.now() > sess.expiresAt) { msDeviceSessions.delete(sessionId); return c.json({ status: "expired" }); }
  try {
    const r = await fetch(`https://login.microsoftonline.com/${sess.tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: sess.clientId,
        device_code: sess.deviceCode,
      }),
    });
    const j = (await r.json()) as {
      access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string;
    };
    if (j.access_token) {
      const expiresAt = new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString();
      let user: GraphUser = {};
      try {
        const pr = await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", {
          headers: { Authorization: `Bearer ${j.access_token}` },
        });
        if (pr.ok) user = await pr.json();
      } catch {
        /* non-fatal */
      }
      const email = user.mail ?? user.userPrincipalName;
      if (!email) {
        msDeviceSessions.delete(sessionId);
        return c.json({ status: "error", error: "Could not read the account email from Microsoft." });
      }
      await upsertAccount({
        provider: "microsoft",
        account_email: email,
        account_name: user.displayName ?? null,
        access_token: j.access_token,
        refresh_token: j.refresh_token ?? "",
        expires_at: expiresAt,
        scopes: GRAPH_SCOPES,
      });
      msDeviceSessions.delete(sessionId);
      return c.json({ status: "authorized", email });
    }
    if (j.error === "authorization_pending" || j.error === "slow_down") return c.json({ status: "pending" });
    msDeviceSessions.delete(sessionId);
    return c.json({ status: "error", error: j.error_description || j.error || "device flow failed" });
  } catch (err) {
    return c.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, 502);
  }
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
    client_id: getMsGraphClientId(),
    client_secret: getMsGraphClientSecret(),
    code,
    redirect_uri: getMsGraphRedirectUri(),
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
    // Non-fatal; still save the tokens if we can identify the account.
  }

  // The account's email is its identity: re-connecting the same account updates
  // its row, a new account adds one.
  const email = user.mail ?? user.userPrincipalName;
  if (!email) {
    return c.redirect(
      new URL(`/settings?ms_error=${encodeURIComponent("Could not read the account email from Microsoft.")}`, c.req.url).toString(),
      302,
    );
  }

  await upsertAccount({
    provider: "microsoft",
    account_email: email,
    account_name: user.displayName ?? null,
    access_token: json.access_token as string,
    refresh_token: json.refresh_token as string,
    expires_at: expiresAt,
    scopes: GRAPH_SCOPES,
  });

  return c.redirect(new URL("/settings?ms_connected=1", c.req.url).toString(), 302);
});

auth.post("/ms-graph/disconnect", async (c) => {
  const { id } = (await c.req.json().catch(() => ({}))) as { id?: string };
  if (!id) return c.json({ error: "account id required" }, 400);
  await removeAccount(id);
  return c.json({ ok: true });
});

auth.get("/ms-graph/status", async (c) => {
  const accounts = await listAccounts("microsoft");
  return c.json({
    connected: accounts.length > 0,
    accounts: accounts.map((a) => ({ id: a.id, user_email: a.account_email, user_name: a.account_name })),
  });
});

// App-registration credentials, settable from Settings (no .env edit). The
// client secret is never returned — only hasSecret.
auth.get("/ms-graph/creds", (c) => c.json(msGraphCredsStatus()));

auth.put("/ms-graph/creds", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    clientId: string; clientSecret: string; tenantId: string; redirectUri: string;
  }>;
  await setMsGraphCreds(body);
  return c.json({ ok: true, ...msGraphCredsStatus() });
});
