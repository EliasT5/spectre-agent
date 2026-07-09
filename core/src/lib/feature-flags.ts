import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Runtime feature toggles (app_config `feature_flags`), flippable from Settings so
 * a self-hoster never has to edit `.env`. Each falls back to its operator env flag
 * when no runtime override is set. Mirrors danger-settings.ts.
 *
 *   cliUi       — manage the subscription CLI brains from Settings (env SPECTRE_ALLOW_CLI_UI)
 *   cliBackends — allow cli-server / cli-command backends that SPAWN operator-
 *                 supplied commands = RCE by design (env SPECTRE_ALLOW_CLI_BACKENDS).
 *                 A Danger-Zone toggle; user-only (never flipped by an agent tool).
 */
export interface FeatureFlags {
  cliUi: boolean;
  cliBackends: boolean;
}

const KEY = "feature_flags";
let stored: Partial<FeatureFlags> = {};

export function isCliUiAllowed(): boolean {
  return typeof stored.cliUi === "boolean" ? stored.cliUi : process.env.SPECTRE_ALLOW_CLI_UI === "1";
}
export function isCliBackendsAllowed(): boolean {
  return typeof stored.cliBackends === "boolean" ? stored.cliBackends : process.env.SPECTRE_ALLOW_CLI_BACKENDS === "1";
}

export function featureFlagsStatus(): FeatureFlags {
  return { cliUi: isCliUiAllowed(), cliBackends: isCliBackendsAllowed() };
}

export async function setFeatureFlags(patch: Partial<FeatureFlags>): Promise<void> {
  if (typeof patch.cliUi === "boolean") stored.cliUi = patch.cliUi;
  if (typeof patch.cliBackends === "boolean") stored.cliBackends = patch.cliBackends;
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft: in-memory still applies for this process */
  }
}

export async function hydrateFeatureFlags(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") stored = v as Partial<FeatureFlags>;
    }
  } catch {
    /* fail-soft */
  }
}

void hydrateFeatureFlags();
