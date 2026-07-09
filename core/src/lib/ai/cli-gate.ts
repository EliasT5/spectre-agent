import { spawn } from "child_process";
import { createServiceSupabase } from "@/lib/supabase/server";
import { isCliUiAllowed } from "@/lib/feature-flags";

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

// "May the Settings UI manage CLI providers at runtime?" is now the runtime
// feature flag isCliUiAllowed() (Settings -> Danger Zone; env SPECTRE_ALLOW_CLI_UI
// fallback), imported above.

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

// Runtime overrides (id -> on/off). Only consulted when isCliUiAllowed().
const override: Partial<Record<CliId, boolean>> = {};

/** The effective gate — synchronous, safe to call in hot paths. */
export function cliAllowed(id: CliId): boolean {
  if (isCliUiAllowed() && id in override) return override[id] === true;
  return envDefault(id);
}

// Runtime-set auth credentials (id -> token), entered from the UI so a CLI can be
// authenticated with NO file edit / restart. The provider injects the token into the
// spawned CLI's env at call time (e.g. claude-code → CLAUDE_CODE_OAUTH_TOKEN).
const TOKENS_KEY = "cli_tokens";
const tokens: Partial<Record<CliId, string>> = {};

/** The runtime token for a CLI, if the operator set one via the UI. Sync. */
export function getCliToken(id: CliId): string | undefined {
  return tokens[id] || undefined;
}
export function hasCliToken(id: CliId): boolean {
  return !!tokens[id];
}

export interface CliGateRow {
  id: CliId;
  label: string;
  enabled: boolean;
  envDefault: boolean;
  envVar: string;
  /** True when the UI is permitted to flip this CLI (the operator master flag). */
  canManage: boolean;
  /** True when a runtime auth token has been set for this CLI (value never returned). */
  hasToken: boolean;
  /** True when a runtime binary path/command has been set (value returned as `bin`). */
  hasBin: boolean;
  /** The resolved command/path Spectre will spawn. */
  bin: string;
  /** True when the user has configured this CLI in any way (drives the modular card). */
  added: boolean;
}

export function getCliGate(): { uiAllowed: boolean; items: CliGateRow[] } {
  return {
    uiAllowed: isCliUiAllowed(),
    items: CLI_IDS.map((id) => ({
      id,
      label: META[id].label,
      enabled: cliAllowed(id),
      envDefault: envDefault(id),
      envVar: META[id].envVar,
      canManage: isCliUiAllowed(),
      hasToken: hasCliToken(id),
      hasBin: hasCliBin(id),
      bin: getCliBin(id),
      added: cliAdded(id),
    })),
  };
}

/** Set (or clear, when token is empty) a CLI's runtime auth token. UI-gated. */
export async function setCliToken(id: CliId, token: string): Promise<void> {
  if (!isCliUiAllowed()) {
    throw new Error(
      "CLI management from the UI is disabled. Set SPECTRE_ALLOW_CLI_UI=1 on the core to enable it.",
    );
  }
  if (token && token.trim()) tokens[id] = token.trim();
  else delete tokens[id];
  await persistTokens();
}

async function persistTokens(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: TOKENS_KEY, value: JSON.stringify(tokens), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    // Fail-soft: the in-memory token still works for this process.
  }
}

// Runtime binary path override (id -> command or absolute path), set from the UI so
// a known deep-integration CLI can be located without an env var. Falls back to the
// env-configured META bin. This is what makes the CLI card modular: the user enters
// `claude` (or a full path) and Spectre uses it.
const BINS_KEY = "cli_bins";
const bins: Partial<Record<CliId, string>> = {};

/** Resolve the command/path for a CLI: UI override → env/META default. Sync. */
export function getCliBin(id: CliId): string {
  return bins[id] || META[id].bin;
}
export function hasCliBin(id: CliId): boolean {
  return !!bins[id];
}

/** Set (or clear) a CLI's binary command/path from the UI. UI-gated. */
export async function setCliBin(id: CliId, pathOrCmd: string): Promise<void> {
  if (!isCliUiAllowed()) {
    throw new Error("CLI management from the UI is disabled. Set SPECTRE_ALLOW_CLI_UI=1 on the core.");
  }
  if (pathOrCmd && pathOrCmd.trim()) bins[id] = pathOrCmd.trim();
  else delete bins[id];
  await persistBins();
}

async function persistBins(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: BINS_KEY, value: JSON.stringify(bins), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    // Fail-soft.
  }
}

/** Is this CLI "added" (the user configured it in any way)? Drives the modular card. */
export function cliAdded(id: CliId): boolean {
  return cliAllowed(id) || hasCliToken(id) || hasCliBin(id);
}

/** Flip a CLI at runtime. Throws (with a clear reason) when not permitted. */
export async function setCliEnabled(id: CliId, on: boolean): Promise<void> {
  if (!isCliUiAllowed()) {
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
    // Runtime auth tokens set via the UI (cli_tokens).
    const { data: tokRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", TOKENS_KEY)
      .maybeSingle();
    if (tokRow?.value) {
      const parsed = JSON.parse(tokRow.value as string) as Partial<Record<CliId, string>>;
      for (const id of CLI_IDS) {
        if (typeof parsed[id] === "string" && parsed[id]) tokens[id] = parsed[id];
      }
    }
    // Runtime binary path overrides (cli_bins).
    const { data: binRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", BINS_KEY)
      .maybeSingle();
    if (binRow?.value) {
      const parsed = JSON.parse(binRow.value as string) as Partial<Record<CliId, string>>;
      for (const id of CLI_IDS) {
        if (typeof parsed[id] === "string" && parsed[id]) bins[id] = parsed[id];
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
  const bin = getCliBin(id);
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
