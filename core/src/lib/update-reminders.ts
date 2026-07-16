import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Update-reminder settings (app_config `update_reminders`), set from Settings →
 * Updates so a self-hoster never edits `.env`. Controls the conversational
 * reminder the 6-hourly update detector opens (routes/update.ts), split PER
 * TARGET (core vs shell) so each can be nudged/auto-applied independently.
 * Mirrors feature-flags.ts: in-memory value + app_config upsert + hydrate at load.
 *
 *   mode        "ask"  — open a reminder chat per new remote SHA;
 *               "auto" — same reminder, phrased for a host auto-update cron
 *               (a container can't rebuild itself; the host `--auto` runner
 *               applies it — see scripts/spectre-update.mjs);
 *               "off"  — no reminders for that target.
 *   mutedUntil  epoch ms — reminders for that target stay quiet until this passes.
 *
 * Defaults: core auto (recommended — core is the engine), shell ask (applying it
 * overwrites the shell's committed files).
 */
export type UpdateReminderMode = "ask" | "auto" | "off";
export type UpdateTarget = "core" | "shell";

export interface TargetReminders {
  mode: UpdateReminderMode;
  mutedUntil?: number;
}

export interface UpdateReminders {
  core: TargetReminders;
  shell: TargetReminders;
}

const KEY = "update_reminders";
const MODES: readonly UpdateReminderMode[] = ["ask", "auto", "off"] as const;
export const TARGETS: readonly UpdateTarget[] = ["core", "shell"] as const;

function defaults(): UpdateReminders {
  return { core: { mode: "auto" }, shell: { mode: "ask" } };
}

let stored: UpdateReminders = defaults();

export function getUpdateReminders(): UpdateReminders {
  return { core: { ...stored.core }, shell: { ...stored.shell } };
}

/** True when reminders for `target` should fire at `now` — not off, not muted. */
export function remindersActive(target: UpdateTarget, now: number): boolean {
  const t = stored[target];
  if (t.mode === "off") return false;
  if (typeof t.mutedUntil === "number" && now < t.mutedUntil) return false;
  return true;
}

export async function setUpdateReminders(
  target: UpdateTarget,
  patch: Partial<TargetReminders>,
): Promise<UpdateReminders> {
  const t = stored[target];
  if (patch.mode && MODES.includes(patch.mode)) t.mode = patch.mode;
  if (typeof patch.mutedUntil === "number" && Number.isFinite(patch.mutedUntil)) {
    t.mutedUntil = patch.mutedUntil;
  }
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft: in-memory still applies for this process */
  }
  return getUpdateReminders();
}

/** Coerce an arbitrary stored value into one target's settings; unknown → default. */
function coerceTarget(v: unknown, fallbackMode: UpdateReminderMode): TargetReminders {
  const o = (v ?? {}) as Partial<TargetReminders>;
  return {
    mode: o.mode && MODES.includes(o.mode) ? o.mode : fallbackMode,
    ...(typeof o.mutedUntil === "number" && Number.isFinite(o.mutedUntil)
      ? { mutedUntil: o.mutedUntil }
      : {}),
  };
}

/**
 * Seed from app_config at startup. Idempotent; fail-soft. Accepts BOTH the new
 * per-target shape `{core,shell}` AND the OLD flat `{mode,mutedUntil}` (applied
 * to both targets) so an existing row keeps working. Unknown → defaults.
 */
export async function hydrateUpdateReminders(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (!data?.value) return;
    const v = JSON.parse(data.value as string) as Record<string, unknown>;
    if (!v || typeof v !== "object") return;
    const def = defaults();
    if ("core" in v || "shell" in v) {
      // New per-target shape.
      stored = {
        core: coerceTarget(v.core, def.core.mode),
        shell: coerceTarget(v.shell, def.shell.mode),
      };
    } else if ("mode" in v || "mutedUntil" in v) {
      // Legacy flat shape → apply the same settings to both targets.
      const flat = coerceTarget(v, "ask");
      stored = { core: { ...flat }, shell: { ...flat } };
    }
  } catch {
    /* fail-soft: defaults until set from the UI */
  }
}

void hydrateUpdateReminders();
