import { Hono } from "hono";
import { CLI_IDS, getCliGate, setCliEnabled, probeCliBinary, type CliId } from "@/lib/ai/cli-gate";

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
