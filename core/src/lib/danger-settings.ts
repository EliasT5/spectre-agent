import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * "Danger Zone" toggles — operator-only switches that loosen the agent's guard
 * rails, set from Settings → Danger Zone and stored in app_config. Defaults are
 * the SAFE values; a toggle must be deliberately turned on.
 *
 *  - allowEnvAccess: when false (default), the permission broker denies any
 *    bash/write/edit that reads or touches a `.env*` file (secrets). The agent's
 *    autonomy/permission mode also lives in this section, but that has its own
 *    store (module-open lib); this file only owns the extra danger toggles.
 */
export interface DangerSettings {
  allowEnvAccess: boolean;
}

const KEY = "danger_settings";
let settings: DangerSettings = { allowEnvAccess: false };

export function getDangerSettings(): DangerSettings {
  return settings;
}

export async function setDangerSettings(patch: Partial<DangerSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(settings), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft: in-memory value still applies for this process */
  }
}

/** Seed from app_config at startup. Idempotent; fail-soft to the safe defaults. */
export async function hydrateDangerSettings(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") settings = { ...settings, ...(v as Partial<DangerSettings>) };
    }
  } catch {
    /* fail-soft: keep safe defaults */
  }
}

void hydrateDangerSettings();
