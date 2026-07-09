import { Hono } from "hono";
import { CLI_IDS, getCliGate, setCliEnabled, setCliToken, setCliBin, probeCliBinary, type CliId } from "@/lib/ai/cli-gate";
import { validateBackend } from "@/lib/ai/backends/schema";
import { buildApiLiteLLMBody } from "@/lib/ai/backends/litellm-map";
import { registerModel, deleteModel } from "@/lib/ai/backends/litellm-admin";
import {
  listBackends,
  getBackendSync,
  upsertBackend,
  deleteBackend as removeBackend,
  setBackendEnabled,
} from "@/lib/ai/backends/registry";
import { isCliBackendsAllowed, assertBackendAllowed, probeBackend } from "@/lib/ai/backends/gate";
import { startServer, stopServer, serverStatus } from "@/lib/ai/backends/supervisor";
import { getGithubToken, hasGithubToken, setGithubToken } from "@/lib/github-token";
import { generateVapid, setVapid, vapidStatus } from "@/lib/vapid";
import { channelsStatus, setChannels, type ChannelConfig } from "@/lib/channel-config";

/**
 * /api/providers/models - add/remove a provider model on the LiteLLM gateway at
 * RUNTIME (no redeploy), the "add a provider via Settings" path. Forwards to
 * LiteLLM's admin API (/model/new, /model/delete) using the gateway's master key.
 *
 * Requires a real LiteLLM proxy with a master key (and, to persist across
 * restarts, store_model_in_db + a Postgres - see litellm-config.yaml). A plain
 * gateway like Ollama has no admin API, so add returns a clear instruction to
 * edit litellm-config.yaml instead. Auth is the standard CORE_TOKEN gate via
 * proxy.ts (same as every other /api/* route).
 */

export const providers = new Hono();

/** LiteLLM admin endpoints live at the server root, not under /v1. */
function adminBase(): string | null {
  const url = process.env.SPECTRE_LITELLM_URL;
  if (!url) return null;
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const key = process.env.SPECTRE_LITELLM_KEY || "";
  return {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

// LiteLLM's /model/new response echoes the litellm_params it stored — INCLUDING
// the api_key the caller submitted (verbatim on success, AND inside validation
// error.message strings on rejection). So we scrub a reflected gateway response
// two ways before returning it: (1) redact credential-NAMED fields, and (2) mask
// credential-shaped VALUES — the exact submitted key plus common key patterns —
// so a key embedded in a free-text message can't slip through a key-name filter.
const KEY_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{20,})/g;

function scrubString(s: string, submitted?: string): string {
  let out = s;
  if (submitted && submitted.length >= 8) out = out.split(submitted).join("[redacted]");
  return out.replace(KEY_VALUE_PATTERN, "[redacted]");
}

function scrub(v: unknown, submitted?: string): unknown {
  if (typeof v === "string") return scrubString(v, submitted);
  if (Array.isArray(v)) return v.map((x) => scrub(x, submitted));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /(api[_-]?key|secret|token|password|authorization|bearer|credential|access[_-]?key)/i.test(k)
        ? "[redacted]"
        : scrub(val, submitted);
    }
    return out;
  }
  return v;
}

providers.post("/models", async (c) => {
  const base = adminBase();
  if (!base) {
    return c.json(
      { error: "No model gateway configured. Set SPECTRE_LITELLM_URL." },
      400,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    modelName?: string;
    model?: string;
    apiKey?: string;
    apiBase?: string;
  };
  if (!body.modelName || !body.model) {
    return c.json(
      {
        error:
          "modelName (the friendly id Spectre requests) and model (the provider-prefixed id, e.g. 'anthropic/claude-sonnet-4-6') are required.",
      },
      400,
    );
  }

  const params: Record<string, unknown> = { model: body.model };
  if (body.apiKey) params.api_key = body.apiKey;
  if (body.apiBase) params.api_base = body.apiBase;

  try {
    const res = await fetch(`${base}/model/new`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ model_name: body.modelName, litellm_params: params }),
    });
    const text = await res.text();
    if (!res.ok) {
      return c.json(
        {
          error:
            `The gateway rejected the add (HTTP ${res.status}). If your gateway is plain Ollama or a config-only LiteLLM, ` +
            "it has no runtime admin API - add the model to litellm-config.yaml and restart the gateway instead.",
          detail: scrub(safeJson(text), body.apiKey),
        },
        502,
      );
    }
    return c.json({ ok: true, modelName: body.modelName, detail: scrub(safeJson(text), body.apiKey) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

providers.delete("/models", async (c) => {
  const base = adminBase();
  if (!base) {
    return c.json(
      { error: "No model gateway configured. Set SPECTRE_LITELLM_URL." },
      400,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return c.json({ error: "id (the gateway model id) is required." }, 400);
  }
  try {
    const res = await fetch(`${base}/model/delete`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: body.id }),
    });
    const text = await res.text();
    if (!res.ok) {
      return c.json(
        { error: `The gateway rejected the delete (HTTP ${res.status}).`, detail: scrub(safeJson(text)) },
        502,
      );
    }
    return c.json({ ok: true, detail: scrub(safeJson(text)) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

// ── CLI providers (Claude Code / Codex / Gemini) ────────────────────────────
// Subscription-backed CLIs are gated in @/lib/ai/cli-gate (build capability →
// SPECTRE_ALLOW_*_CLI env flag → live override). These endpoints expose that gate
// to Settings → Providers: read each CLI's enabled state + live binary presence,
// and — only when the operator set SPECTRE_ALLOW_CLI_UI=1 — flip it at runtime.
async function cliStateWithBinaries() {
  const gate = getCliGate();
  const present = await Promise.all(gate.items.map((it) => probeCliBinary(it.id)));
  return {
    uiAllowed: gate.uiAllowed,
    items: gate.items.map((it, i) => ({ ...it, binaryOnPath: present[i] })),
  };
}

providers.get("/cli", async (c) => {
  return c.json(await cliStateWithBinaries());
});

providers.put("/cli", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; enabled?: boolean };
  if (!body.id || !(CLI_IDS as readonly string[]).includes(body.id)) {
    return c.json({ error: `id must be one of: ${CLI_IDS.join(", ")}` }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required." }, 400);
  }
  try {
    await setCliEnabled(body.id as CliId, body.enabled);
  } catch (err) {
    // Not permitted (UI management disabled) → 403 with the reason.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 403);
  }
  return c.json({ ok: true, ...(await cliStateWithBinaries()) });
});

// Set (or clear) a CLI's runtime auth token entirely from the UI — no file edit,
// no restart. The value is stored server-side and injected into the spawned CLI's
// env at call time; it is never returned by GET /cli (only `hasToken`).
providers.put("/cli/token", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; token?: string };
  if (!body.id || !(CLI_IDS as readonly string[]).includes(body.id)) {
    return c.json({ error: `id must be one of: ${CLI_IDS.join(", ")}` }, 400);
  }
  if (typeof body.token !== "string") {
    return c.json({ error: "token (string; empty to clear) is required." }, 400);
  }
  try {
    await setCliToken(body.id as CliId, body.token);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 403);
  }
  return c.json({ ok: true, ...(await cliStateWithBinaries()) });
});

// Set (or clear) a CLI's binary command/PATH entry entirely from the UI — the user
// types `claude` or a full path, Spectre spawns that. Makes the deep-integration
// CLIs modular: default none, located by what the user enters.
providers.put("/cli/bin", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; bin?: string };
  if (!body.id || !(CLI_IDS as readonly string[]).includes(body.id)) {
    return c.json({ error: `id must be one of: ${CLI_IDS.join(", ")}` }, 400);
  }
  if (typeof body.bin !== "string") {
    return c.json({ error: "bin (string command/path; empty to clear) is required." }, 400);
  }
  try {
    await setCliBin(body.id as CliId, body.bin);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 403);
  }
  return c.json({ ok: true, ...(await cliStateWithBinaries()) });
});

// ── GitHub token (runtime, set from Settings — no .env edit) ────────────────
// Used by the Workspace clone/push flow. Stored in app_config; never echoed back
// to the UI (GET /github reports only hasToken). The value endpoint is for the
// trusted shell /api/workspace proxy to inject into the isolated workspace-service
// (which holds no core creds), never for the browser.
providers.get("/github", (c) => c.json({ hasToken: hasGithubToken() }));

providers.put("/github/token", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (typeof body.token !== "string") {
    return c.json({ error: "token (string; empty to clear) is required." }, 400);
  }
  await setGithubToken(body.token);
  return c.json({ ok: true, hasToken: hasGithubToken() });
});

providers.get("/github/token", (c) => c.json({ token: getGithubToken() }));

// "Just login" — GitHub OAuth device flow (like `gh auth login`). Default client
// id is the GitHub CLI's public one (override with SPECTRE_GITHUB_CLIENT_ID);
// GitHub shows "GitHub CLI" as the authorizing app. The granted token is stored in
// the same app_config github_token, so the Workspace injection path is unchanged.
const GH_CLIENT_ID = process.env.SPECTRE_GITHUB_CLIENT_ID || "178c6fc778ccc68e1d6a";
const deviceSessions = new Map<string, { deviceCode: string; interval: number; expiresAt: number }>();

providers.post("/github/device/start", async (c) => {
  try {
    const r = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: "repo" }),
    });
    const j = (await r.json()) as {
      device_code?: string; user_code?: string; verification_uri?: string;
      interval?: number; expires_in?: number; error?: string;
    };
    if (!r.ok || !j.device_code) {
      return c.json({ error: j.error || `GitHub device start failed (HTTP ${r.status}).` }, 502);
    }
    const sessionId = crypto.randomUUID();
    deviceSessions.set(sessionId, {
      deviceCode: j.device_code,
      interval: j.interval ?? 5,
      expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
    });
    return c.json({ sessionId, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval ?? 5 });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

providers.post("/github/device/poll", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string };
  const sid = body.sessionId;
  const sess = sid ? deviceSessions.get(sid) : undefined;
  if (!sid || !sess) return c.json({ status: "expired" });
  if (Date.now() > sess.expiresAt) { deviceSessions.delete(sid); return c.json({ status: "expired" }); }
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GH_CLIENT_ID,
        device_code: sess.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const j = (await r.json()) as { access_token?: string; error?: string; interval?: number };
    if (j.access_token) {
      await setGithubToken(j.access_token);
      deviceSessions.delete(sid);
      return c.json({ status: "authorized", hasToken: hasGithubToken() });
    }
    if (j.error === "authorization_pending") return c.json({ status: "pending" });
    if (j.error === "slow_down") return c.json({ status: "pending", interval: j.interval });
    deviceSessions.delete(sid); // expired_token / access_denied / unsupported
    return c.json({ status: "error", error: j.error || "device flow failed" });
  } catch (err) {
    return c.json({ status: "error", error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ── Web push (VAPID) keys (runtime, set from Settings — no .env edit) ────────
providers.get("/vapid", (c) => c.json(vapidStatus()));

providers.put("/vapid", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{ subject: string; publicKey: string; privateKey: string }>;
  await setVapid(body);
  return c.json({ ok: true, ...vapidStatus() });
});

providers.post("/vapid/generate", async (c) => {
  const { publicKey } = await generateVapid();
  return c.json({ ok: true, ...vapidStatus(), publicKey });
});

// ── Messaging channels (Telegram / WhatsApp / Discord) — runtime tokens ─────
// Set from Settings, stored in app_config; the channel-runner worker refreshes
// them live. Only `hasX` booleans + non-secret bits are ever returned.
providers.get("/channels", (c) => c.json(channelsStatus()));

providers.put("/channels", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ChannelConfig>;
  await setChannels(body);
  return c.json({ ok: true, ...channelsStatus() });
});

// ── Model backends (unified: api / cli-server / cli-command) ────────────────
// The "teach Spectre a model" write path. api backends register on the LiteLLM
// gateway (like /models); cli-server + cli-command spawn operator commands and are
// gated behind SPECTRE_ALLOW_CLI_BACKENDS. Secrets (api keys) are forwarded to
// LiteLLM and NEVER persisted in the registry.
providers.post("/backends", async (c) => {
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown> & {
    apiKey?: string;
    dryRun?: boolean;
  };
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
  const dryRun = raw.dryRun === true;
  // Strip transient fields before validating/persisting — apiKey is NEVER stored.
  const { apiKey: _k, dryRun: _d, ...specRaw } = raw;
  const v = validateBackend(specRaw);
  if (!v.ok) return c.json({ error: "invalid backend", detail: v.errors }, 400);
  const spec = v.backend;

  try {
    if (spec.kind === "api") {
      const body = buildApiLiteLLMBody(spec, apiKey);
      const res = await registerModel(body, apiKey);
      if (!res.ok) {
        return c.json(
          {
            error: `The gateway rejected the model (HTTP ${res.status}). A plain Ollama/config-only gateway has no runtime admin API — add it to litellm-config.yaml and restart instead.`,
            detail: res.detail,
          },
          502,
        );
      }
      if (dryRun) {
        if (res.litellmModelId) await deleteModel(res.litellmModelId).catch(() => {});
        return c.json({ ok: true, dryRun: true, detail: res.detail });
      }
      await upsertBackend({ ...spec, litellmModelId: res.litellmModelId });
      return c.json({ ok: true, id: spec.id, detail: res.detail });
    }

    // cli-server / cli-command spawn operator commands → require the master flag.
    assertBackendAllowed(spec.kind);

    if (dryRun) {
      const ok = await probeBackend(spec);
      return c.json({ ok, dryRun: true, detail: ok ? "command is runnable" : "command not found / not runnable on PATH" });
    }

    await upsertBackend(spec);
    if (spec.kind === "cli-server") {
      const st = await startServer(spec);
      return c.json({ ok: st.status !== "failed", id: spec.id, status: st.status, error: st.error });
    }
    // cli-command: upsert already materialized backends.json (broker registers the
    // dispatch tool on the next turn) and the snapshot makes the brain selectable.
    return c.json({ ok: true, id: spec.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, /disabled/i.test(msg) ? 403 : 500);
  }
});

providers.get("/backends", async (c) => {
  const backends = await listBackends();
  const items = backends.map((b) => {
    const item: Record<string, unknown> = {
      id: b.id,
      kind: b.kind,
      label: b.label,
      enabled: b.enabled,
      roles: b.roles,
      endpointType: b.endpointType,
      modelName: b.modelName || b.id,
      command: b.command,
    };
    if (b.kind === "cli-server") item.server = serverStatus(b.id) ?? { status: "stopped" };
    return item;
  });
  return c.json({ uiAllowed: isCliBackendsAllowed(), backends: items });
});

providers.put("/backends/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) is required." }, 400);
  const cur = getBackendSync(id);
  if (!cur) return c.json({ error: "backend not found" }, 404);
  try {
    if (cur.kind !== "api") assertBackendAllowed(cur.kind);
    const next = await setBackendEnabled(id, body.enabled);
    if (next?.kind === "cli-server") {
      if (body.enabled) await startServer(next);
      else await stopServer(id);
    }
    return c.json({ ok: true, id, enabled: body.enabled });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 403);
  }
});

providers.delete("/backends/:id", async (c) => {
  const id = c.req.param("id");
  const cur = getBackendSync(id);
  if (!cur) return c.json({ error: "backend not found" }, 404);
  try {
    if (cur.kind === "api" && cur.litellmModelId) await deleteModel(cur.litellmModelId).catch(() => {});
    if (cur.kind === "cli-server") await stopServer(id);
    await removeBackend(id);
    return c.json({ ok: true, id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
