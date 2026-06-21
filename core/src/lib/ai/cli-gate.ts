import { spawn } from "child_process";
import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Runtime gate for the subscription-backed CLI providers (Claude Code / Codex /
 * Gemini). Single source of truth — every availability check and spawn guard
 * across the AI layer routes through `cliAllowed()`.
 *
 * All three are OFF by default: the default brain is the provider-agnostic
 * LiteLLM loop on your own keys / local models. The CLIs run on YOUR OWN
 * personal subscription, through the vendor's own CLI / agent SDK, on your own
 * machine — so they are opt-in, gated the same way for all three:
 *   1. OPERATOR env flag (`SPECTRE_ALLOW_*_CLI=1`) — the default, restart-scoped control.
 *   2. RUNTIME override from Settings — only when the operator sets
 *      `SPECTRE_ALLOW_CLI_UI=1`. Seeded from `app_config` at startup, flipped
 *      live by PUT /api/providers/cli, persisted back to `app_config`.
 */

export type CliId = "claude-code" | "codex-cli" | "gemini-cli";
export const CLI_IDS: readonly CliId[] = ["claude-code", "codex-cli", "gemini-cli"];

/** Operator master switch: may the Settings UI manage CLI providers at runtime? */
export const CLI_UI_ALLOWED = process.env.SPECTRE_ALLOW_CLI_UI === "1";

interface CliMeta {
  label: string;
  bin: string;
  envVar: string;
}

const META: Record<CliId, CliMeta> = {
  "claude-code": { label: "Claude CLI", bin: process.env.CLAUDE_BIN || "claude", envVar: "SPECTRE_ALLOW_CLAUDE_CLI" },
  "codex-cli": { label: "Codex CLI", bin: process.env.CODEX_CLI_BIN || "codex", envVar: "SPECTRE_ALLOW_CODEX_CLI" },
  "gemini-cli": { label: "Gemini CLI", bin: process.env.GEMINI_CLI_BIN || "gemini", envVar: "SPECTRE_ALLOW_GEMINI_CLI" },
};

const APP_CONFIG_KEY = "cli_overrides";

/** The env-flag default. */
function envDefault(id: CliId): boolean {
  return process.env[META[id].envVar] === "1";
}

// Runtime overrides (id -> on/off). Only consulted when CLI_UI_ALLOWED.
const override: Partial<Record<CliId, boolean>> = {};

/** The effective gate — synchronous, safe to call in hot paths. */
export function cliAllowed(id: CliId): boolean {
  if (CLI_UI_ALLOWED && id in override) return override[id] === true;
  return envDefault(id);
}

export interface CliGateRow {
  id: CliId;
  label: string;
  enabled: boolean;
  envDefault: boolean;
  envVar: string;
  /** True when the UI is permitted to flip this CLI (the operator master flag). */
  canManage: boolean;
}

export function getCliGate(): { uiAllowed: boolean; items: CliGateRow[] } {
  return {
    uiAllowed: CLI_UI_ALLOWED,
    items: CLI_IDS.map((id) => ({
      id,
      label: META[id].label,
      enabled: cliAllowed(id),
      envDefault: envDefault(id),
      envVar: META[id].envVar,
      canManage: CLI_UI_ALLOWED,
    })),
  };
}

/** Flip a CLI at runtime. Throws (with a clear reason) when not permitted. */
export async function setCliEnabled(id: CliId, on: boolean): Promise<void> {
  if (!CLI_UI_ALLOWED) {
    throw new Error(
      "CLI management from the UI is disabled. Set SPECTRE_ALLOW_CLI_UI=1 on the core to enable it.",
    );
  }
  override[id] = on;
  await persist();
}

async function persist(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: APP_CONFIG_KEY, value: JSON.stringify(override), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    // Fail-soft: the in-memory override still governs this process; it just
    // won't survive a restart. Surfacing a 500 to the toggle would be worse.
  }
}

let hydrated = false;
/** Seed runtime overrides from app_config. Idempotent; fail-soft to env defaults. */
export async function hydrateCliGate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", APP_CONFIG_KEY)
      .maybeSingle();
    if (data?.value) {
      const parsed = JSON.parse(data.value as string) as Partial<Record<CliId, boolean>>;
      for (const id of CLI_IDS) {
        if (typeof parsed[id] === "boolean") override[id] = parsed[id];
      }
    }
  } catch {
    // Fail-soft: env defaults stand.
  }
}

// Kick hydration off at module load (fire-and-forget). createServiceSupabase
// reads env that is available at import time; any failure leaves env defaults in
// effect, and the gate stays correct because cliAllowed() only consults the
// override map once it has been populated.
void hydrateCliGate();

/**
 * Gate-INDEPENDENT binary probe for the Settings status dots — answers "is the
 * CLI installed on PATH?" regardless of whether it's currently enabled.
 */
export function probeCliBinary(id: CliId): Promise<boolean> {
  const { bin } = META[id];
  return new Promise((resolve) => {
    try {
      const proc = spawn(bin, ["--version"], { stdio: "ignore" });
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
