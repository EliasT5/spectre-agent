/**
 * Global daily spend gate (audit B6) — the usage route METERS, this ENFORCES.
 *
 * SPECTRE_DAILY_SPEND_CAP_USD > 0 blocks api-billed turns once the blended
 * 24h estimate crosses the cap. Local (Ollama) and subscription (Claude CLI)
 * models are never blocked — they have no per-token cost.
 *
 * FAIL-OPEN: a metering/DB blip must not brick chat; report and let the turn
 * through instead.
 */
import { createServiceSupabase } from "@/lib/supabase/server";
import { reportEvent } from "@/lib/monitor/report";
import { classify } from "./model-cost";

export interface SpendCapVerdict {
  blocked: boolean;
  spentUsd: number;
  capUsd: number;
}

export async function checkSpendCap(modelId: string): Promise<SpendCapVerdict> {
  const capUsd = Number(process.env.SPECTRE_DAILY_SPEND_CAP_USD || 0);
  const open = { blocked: false, spentUsd: 0, capUsd };
  if (!(capUsd > 0)) return open;
  if (classify(modelId).mode !== "api") return open;
  try {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const supabase = createServiceSupabase();
    const { data, error } = await supabase
      .from("messages")
      .select("model_used, token_count")
      .eq("role", "assistant")
      .not("model_used", "is", null)
      .gte("created_at", since);
    if (error) throw new Error(error.message);
    let spentUsd = 0;
    for (const row of data ?? []) {
      const { mode, rate } = classify(String(row.model_used));
      if (mode !== "api") continue;
      spentUsd += ((Number(row.token_count) || 0) / 1_000_000) * rate;
    }
    return { blocked: spentUsd >= capUsd, spentUsd, capUsd };
  } catch (err) {
    void reportEvent({
      severity: "warning",
      component: "spend-cap",
      description: `Spend-cap check failed (failing open): ${err instanceof Error ? err.message : String(err)}`,
    });
    return open;
  }
}
