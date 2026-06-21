import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { classify } from "@/lib/ai/model-cost";

/**
 * Usage meter - aggregates messages.token_count by model_used over a window.
 *
 * Tags each row with a billing-mode hint so the UI can render appropriately:
 *   - "api"          -> token-based cloud pricing (OpenAI, Anthropic API, Google)
 *   - "subscription" -> Claude Code via OAuth (no per-token cost, but tracked
 *                       against the user's Pro/Max session quota)
 *   - "local"        -> Ollama / on-device models (no $ cost)
 *
 * The DB stores total tokens per assistant message (input + output combined,
 * as `token_count`). We don't separate input vs. output - so cost estimates
 * use a blended rate per model. Real bills will differ; treat numbers as
 * directional, not exact.
 */

export const usage = new Hono();

usage.get("/", async (c) => {
  const hours = Math.max(1, Math.min(720, Number(c.req.query("hours") ?? 24)));

  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("messages")
    .select("model_used, token_count, latency_ms, created_at")
    .eq("role", "assistant")
    .not("model_used", "is", null)
    .gte("created_at", since);

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  type Row = {
    model_used: string;
    token_count: number | null;
    latency_ms: number | null;
    created_at: string;
  };
  const rows = (data ?? []) as Row[];

  // Aggregate per model
  const byModel = new Map<
    string,
    { tokens: number; messages: number; latencyMsTotal: number; latencyCount: number; lastUsed: string }
  >();
  for (const r of rows) {
    const key = r.model_used;
    if (!key) continue;
    const cur = byModel.get(key) ?? {
      tokens: 0,
      messages: 0,
      latencyMsTotal: 0,
      latencyCount: 0,
      lastUsed: r.created_at,
    };
    cur.tokens += r.token_count ?? 0;
    cur.messages += 1;
    if (r.latency_ms != null) {
      cur.latencyMsTotal += r.latency_ms;
      cur.latencyCount += 1;
    }
    if (r.created_at > cur.lastUsed) cur.lastUsed = r.created_at;
    byModel.set(key, cur);
  }

  const items = [...byModel.entries()]
    .map(([model, agg]) => {
      const { mode, rate } = classify(model);
      const estUsd = mode === "api" ? (agg.tokens / 1_000_000) * rate : 0;
      const avgLatencyMs = agg.latencyCount > 0 ? Math.round(agg.latencyMsTotal / agg.latencyCount) : null;
      return {
        model,
        mode,
        tokens: agg.tokens,
        messages: agg.messages,
        avgLatencyMs,
        lastUsed: agg.lastUsed,
        estimatedUsd: Number(estUsd.toFixed(4)),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);

  // Totals split by mode
  const totals = {
    tokens: items.reduce((s, x) => s + x.tokens, 0),
    messages: items.reduce((s, x) => s + x.messages, 0),
    estimatedUsd: Number(items.reduce((s, x) => s + x.estimatedUsd, 0).toFixed(4)),
    byMode: {
      api: items.filter((x) => x.mode === "api").reduce((s, x) => s + x.tokens, 0),
      subscription: items.filter((x) => x.mode === "subscription").reduce((s, x) => s + x.tokens, 0),
      local: items.filter((x) => x.mode === "local").reduce((s, x) => s + x.tokens, 0),
    },
  };

  return c.json({
    windowHours: hours,
    since,
    totals,
    items,
  });
});
