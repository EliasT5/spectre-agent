/**
 * Thin client for LiteLLM's runtime admin API (/model/new, /model/delete), which
 * lives at the server ROOT (not under /v1). Used by the /backends routes (api
 * backends) and the cli-server supervisor. Includes the response key-scrubber so a
 * reflected api_key never leaks back to the caller.
 */
import type { LiteLLMBody } from "./litellm-map";

/** LiteLLM admin endpoints are at the server root, not under /v1. */
export function adminBase(): string | null {
  const url = process.env.SPECTRE_LITELLM_URL;
  if (!url) return null;
  return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

export function authHeaders(): Record<string, string> {
  const key = process.env.SPECTRE_LITELLM_KEY || "";
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

const KEY_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{20,})/g;

function scrubString(s: string, submitted?: string): string {
  let out = s;
  if (submitted && submitted.length >= 8) out = out.split(submitted).join("[redacted]");
  return out.replace(KEY_VALUE_PATTERN, "[redacted]");
}

/** Redact credential-named fields AND credential-shaped values from a reflected response. */
export function scrub(v: unknown, submitted?: string): unknown {
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

export interface RegisterResult {
  ok: boolean;
  status: number;
  litellmModelId?: string;
  detail: unknown;
}

/** POST /model/new. `submitted` is the api key to scrub out of the response. */
export async function registerModel(body: LiteLLMBody, submitted?: string): Promise<RegisterResult> {
  const base = adminBase();
  if (!base) return { ok: false, status: 0, detail: "No model gateway configured. Set SPECTRE_LITELLM_URL." };
  const res = await fetch(`${base}/model/new`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = safeJson(text);
  let litellmModelId: string | undefined;
  if (res.ok && parsed && typeof parsed === "object") {
    const info = (parsed as { model_info?: { id?: unknown } }).model_info;
    if (info && typeof info.id === "string") litellmModelId = info.id;
  }
  return { ok: res.ok, status: res.status, litellmModelId, detail: scrub(parsed, submitted) };
}

/** POST /model/delete by the LiteLLM model id (model_info.id). */
export async function deleteModel(litellmModelId: string): Promise<{ ok: boolean; status: number; detail: unknown }> {
  const base = adminBase();
  if (!base) return { ok: false, status: 0, detail: "No model gateway configured." };
  const res = await fetch(`${base}/model/delete`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id: litellmModelId }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, detail: scrub(safeJson(text)) };
}
