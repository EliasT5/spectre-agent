import { readFileSync } from "fs";
import { join } from "path";
import { Hono } from "hono";
import {
  MODEL_CATALOG,
  detectProviders,
  type Provider,
} from "@/lib/ai";
import { listLiteLLMModels } from "@/lib/ai/providers/litellm";
import { listOllamaModels } from "@/lib/ai/providers/ollama";
import { cliAllowed } from "@/lib/ai/cli-gate";

// EXEMPLAR (lib import + async). Port of src/app/api/models/route.ts.
export const models = new Hono();

// ── Live provider model fetchers ───────────────────────────────────────────────
// Each fetches the canonical model list from the provider's own endpoint.
// Fail-soft: any error (network, auth, timeout) returns [].
// The 3s timeout prevents a slow provider from blocking the whole /api/models call.

interface ProviderModelEntry {
  id: string;
  displayName?: string;
}

async function fetchAnthropicModels(): Promise<ProviderModelEntry[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id, displayName: m.display_name }));
  } catch {
    return [];
  }
}

async function fetchOpenAIModels(): Promise<ProviderModelEntry[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id }));
  } catch {
    return [];
  }
}

async function fetchGoogleModels(): Promise<ProviderModelEntry[]> {
  const key = process.env.GOOGLE_GENAI_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name: string; displayName?: string }>;
    };
    return (data.models ?? []).map((m) => ({
      // name is "models/gemini-2.0-flash" — strip the prefix for a usable id
      id: m.name.replace(/^models\//, ""),
      displayName: m.displayName,
    }));
  } catch {
    return [];
  }
}

// ── Reasoning-model detection ──────────────────────────────────────────────────
// Models whose IDs match this pattern get reasoning:true + full effortLevels
// when not already declared in the catalog.
const REASONING_ID_RE = /\bo[0-9][-\w]*|reasoning|thinking|r1\b/i;
const FULL_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
// o-series models exposed via the OpenAI API support low/medium/high only (not xhigh/minimal)
const OPENAI_O_EFFORT_LEVELS = ["low", "medium", "high"] as const;

function isReasoningModel(id: string): boolean {
  return REASONING_ID_RE.test(id);
}

function effortLevelsForApiModel(id: string, provider: Provider): readonly string[] {
  if (provider === "openai") return OPENAI_O_EFFORT_LEVELS;
  return FULL_EFFORT_LEVELS;
}

// ── Model object shape returned by GET /api/models ────────────────────────────
export interface ModelEntry {
  id: string;
  provider: string;
  displayName: string;
  // Availability
  available: boolean;
  unavailableReason?: string;
  // Reasoning / effort
  reasoning?: boolean;
  effortLevels?: readonly string[];
  // Orchestration
  orchestratable?: boolean;
  // Dynamic discovery flag
  detected?: boolean;
}

// ── CLI gate → availability ────────────────────────────────────────────────────
function cliAvailability(
  provider: "claude-code" | "codex-cli" | "gemini-cli",
  liveProviders: Set<Provider>,
): { available: boolean; unavailableReason?: string } {
  const gateOn = cliAllowed(provider);

  if (!gateOn) {
    const envVar =
      provider === "claude-code"
        ? "SPECTRE_ALLOW_CLAUDE_CLI"
        : provider === "codex-cli"
          ? "SPECTRE_ALLOW_CODEX_CLI"
          : "SPECTRE_ALLOW_GEMINI_CLI";
    const label =
      provider === "claude-code" ? "Claude CLI" : provider === "codex-cli" ? "Codex CLI" : "Gemini CLI";
    return {
      available: false,
      unavailableReason: `enable the ${label} in Settings → Providers (or set ${envVar}=1 on the core)`,
    };
  }
  if (!liveProviders.has(provider)) {
    const bin =
      provider === "claude-code" ? "claude" : provider === "codex-cli" ? "codex" : "gemini";
    return {
      available: false,
      unavailableReason: `${bin} binary not found — install it and ensure it is on PATH`,
    };
  }
  return { available: true };
}

models.get("/", async (c) => {
  const [liveProviderSet, litellmIds, ollamaIds, anthropicLive, openaiLive, googleLive] =
    await Promise.all([
      detectProviders(),
      listLiteLLMModels(),
      listOllamaModels(),
      fetchAnthropicModels(),
      fetchOpenAIModels(),
      fetchGoogleModels(),
    ]);

  const available = [...liveProviderSet] as Provider[];

  // Sets of IDs from live API responses for fast lookup.
  const anthropicLiveIds = new Set(anthropicLive.map((m) => m.id));
  const openaiLiveIds = new Set(openaiLive.map((m) => m.id));
  const googleLiveIds = new Set(googleLive.map((m) => m.id));
  const ollamaLiveIds = new Set(ollamaIds);

  const result: ModelEntry[] = [];
  const seenIds = new Set<string>();

  // ── 1. Emit every catalog entry, enriched with availability ────────────────
  for (const m of MODEL_CATALOG) {
    seenIds.add(m.id);

    let avail: boolean;
    let unavailableReason: string | undefined;

    if (m.provider === "claude-code" || m.provider === "codex-cli" || m.provider === "gemini-cli") {
      ({ available: avail, unavailableReason } = cliAvailability(m.provider, liveProviderSet));
    } else if (m.provider === "spectre-mode") {
      // Jerome Mode is available exactly when claude-code is (same subscription).
      avail = liveProviderSet.has("spectre-mode");
      if (!avail) unavailableReason = "enable the Claude CLI in settings (set SPECTRE_ALLOW_CLAUDE_CLI=1)";
    } else if (m.provider === "litellm") {
      avail = liveProviderSet.has("litellm");
      if (!avail) unavailableReason = "configure SPECTRE_LITELLM_URL to enable the LiteLLM gateway";
    } else if (m.provider === "ollama") {
      avail = liveProviderSet.has("ollama") && ollamaLiveIds.has(m.id);
      if (!avail) {
        if (!liveProviderSet.has("ollama")) {
          unavailableReason = "Ollama is not running — start it with `ollama serve`";
        } else {
          unavailableReason = `not pulled in Ollama — run \`ollama pull ${m.id}\``;
        }
      }
    } else if (m.provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        avail = false;
        unavailableReason = "set ANTHROPIC_API_KEY to enable Anthropic API models";
      } else {
        avail = anthropicLiveIds.has(m.id);
        if (!avail) unavailableReason = "model not in your Anthropic account or region-restricted";
      }
    } else if (m.provider === "openai") {
      if (!process.env.OPENAI_API_KEY) {
        avail = false;
        unavailableReason = "set OPENAI_API_KEY to enable OpenAI API models";
      } else {
        avail = openaiLiveIds.has(m.id);
        if (!avail) unavailableReason = "model not in your OpenAI account or region-restricted";
      }
    } else if (m.provider === "google") {
      if (!process.env.GOOGLE_GENAI_API_KEY) {
        avail = false;
        unavailableReason = "set GOOGLE_GENAI_API_KEY to enable Google API models";
      } else {
        avail = googleLiveIds.has(m.id);
        if (!avail) unavailableReason = "model not in your Google account or region-restricted";
      }
    } else {
      avail = available.includes(m.provider as Provider);
    }

    const entry: ModelEntry = {
      id: m.id,
      provider: m.provider,
      displayName: m.displayName,
      available: avail,
    };
    if (unavailableReason) entry.unavailableReason = unavailableReason;
    if (m.reasoning) {
      entry.reasoning = true;
      entry.effortLevels = m.effortLevels ?? [...FULL_EFFORT_LEVELS];
    }
    if (m.orchestratable) entry.orchestratable = true;

    result.push(entry);
  }

  // ── 2. Add dynamically-discovered LiteLLM gateway models ──────────────────
  for (const id of litellmIds) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const reasoning = isReasoningModel(id);
    const entry: ModelEntry = {
      id,
      provider: "litellm",
      displayName: humanizeModelName(id),
      available: liveProviderSet.has("litellm"),
      detected: true,
    };
    if (!entry.available) entry.unavailableReason = "configure SPECTRE_LITELLM_URL to enable the LiteLLM gateway";
    if (reasoning) {
      entry.reasoning = true;
      entry.effortLevels = [...FULL_EFFORT_LEVELS];
    }
    result.push(entry);
  }

  // ── 3. Add live Ollama models not already in catalog ──────────────────────
  const ollamaUp = liveProviderSet.has("ollama");
  for (const id of ollamaIds) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    result.push({
      id,
      provider: "ollama",
      displayName: humanizeModelName(id),
      available: ollamaUp,
      detected: true,
    });
  }

  // ── 4. Add live Anthropic API models not already in catalog ───────────────
  const anthropicUp = liveProviderSet.has("anthropic");
  for (const m of anthropicLive) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const entry: ModelEntry = {
      id: m.id,
      provider: "anthropic",
      displayName: m.displayName ?? humanizeModelName(m.id),
      available: anthropicUp,
      detected: true,
    };
    if (!anthropicUp) entry.unavailableReason = "set ANTHROPIC_API_KEY to enable Anthropic API models";
    result.push(entry);
  }

  // ── 5. Add live OpenAI API models not already in catalog ──────────────────
  const openaiUp = liveProviderSet.has("openai");
  for (const m of openaiLive) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const reasoning = isReasoningModel(m.id);
    const entry: ModelEntry = {
      id: m.id,
      provider: "openai",
      displayName: humanizeModelName(m.id),
      available: openaiUp,
      detected: true,
    };
    if (!openaiUp) entry.unavailableReason = "set OPENAI_API_KEY to enable OpenAI API models";
    if (reasoning) {
      entry.reasoning = true;
      entry.effortLevels = [...effortLevelsForApiModel(m.id, "openai")];
    }
    result.push(entry);
  }

  // ── 6. Add live Google API models not already in catalog ──────────────────
  const googleUp = liveProviderSet.has("google");
  for (const m of googleLive) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const entry: ModelEntry = {
      id: m.id,
      provider: "google",
      displayName: m.displayName ?? humanizeModelName(m.id),
      available: googleUp,
      detected: true,
    };
    if (!googleUp) entry.unavailableReason = "set GOOGLE_GENAI_API_KEY to enable Google API models";
    result.push(entry);
  }

  return c.json({ providers: available, models: result });
});

// ── Humanize a litellm model_name into a readable UI label ──────────────────
// Examples:
//   "spectre-default"        → "Spectre Default"
//   "ollama_chat/qwen2.5:7b" → "Qwen2.5 7B (Ollama)"
//   "spectre-pro"            → "Spectre Pro"
function humanizeModelName(id: string): string {
  // Strip well-known prefix namespaces and annotate with provider hint.
  const providerPrefixes: [RegExp, string][] = [
    [/^ollama(?:_chat)?\//i, "Ollama"],
    [/^anthropic\//i, "Anthropic"],
    [/^openai\//i, "OpenAI"],
    [/^gemini\//i, "Gemini"],
    [/^azure\//i, "Azure"],
    [/^cohere\//i, "Cohere"],
    [/^bedrock\//i, "Bedrock"],
  ];
  let providerSuffix = "";
  let name = id;
  for (const [re, label] of providerPrefixes) {
    if (re.test(id)) {
      name = id.replace(re, "");
      providerSuffix = ` (${label})`;
      break;
    }
  }
  // Turn separators (-, _, :) into spaces, then Title Case each word.
  name = name
    .replace(/[-_:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return `${name}${providerSuffix}`;
}

// Parse model_name values from litellm-config.yaml without a full YAML library.
// Only models listed under the top-level `model_list:` block are returned.
// Comments and blank lines are ignored; whitespace is trimmed.
function parseLiteLLMModelNames(yaml: string): string[] {
  const names: string[] = [];
  let inModelList = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.trimEnd();
    if (/^model_list\s*:/.test(line)) { inModelList = true; continue; }
    // A top-level key (no leading spaces, ends with ':') ends the model_list block.
    if (inModelList && /^\S/.test(line) && line.includes(":") && !/^\s*-/.test(line)) {
      inModelList = false;
    }
    if (!inModelList) continue;
    // Ignore commented-out lines (leading spaces then '#').
    if (/^\s*#/.test(line)) continue;
    // Match both "  - model_name: value" (list item) and "    model_name: value" (nested key).
    const m = line.match(/^\s+(?:-\s+)?model_name\s*:\s*(.+)$/);
    if (m) names.push(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return names;
}

// GET /api/models/litellm — returns the models declared in litellm-config.yaml
// so a chat UI can populate a model picker. Auth is handled by the global
// coreAuth middleware (same as every other /api route). No secrets are returned.
models.get("/litellm", (c) => {
  try {
    // Resolve relative to the repo root — process.cwd() is the repo root when
    // bun runs src/server/main.ts from the project directory (same convention
    // used everywhere else in src/server/routes/*.ts and src/lib/**).
    const yamlPath = join(process.cwd(), "litellm-config.yaml");
    const yaml = readFileSync(yamlPath, "utf8");
    const names = parseLiteLLMModelNames(yaml);

    const list = names.map((id) => ({ id, label: humanizeModelName(id) }));

    // Always put spectre-default first if present (it's the shipped default).
    const defaultIdx = list.findIndex((m) => m.id === "spectre-default");
    if (defaultIdx > 0) {
      const [entry] = list.splice(defaultIdx, 1);
      list.unshift(entry);
    }

    return c.json({ models: list });
  } catch {
    // Fail-soft: missing or unparseable yaml returns an empty list.
    return c.json({ models: [] });
  }
});
