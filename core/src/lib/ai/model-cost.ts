/**
 * Blended model pricing — shared by the usage meter (src/server/routes/usage.ts)
 * and the daily spend gate (src/lib/ai/spend-cap.ts). Rates are input/output
 * averaged list prices: directional, not exact.
 */

export type Billing = "api" | "subscription" | "local";

// Blended USD per million tokens (input/output averaged, public list prices
// as of 2026-04). Tweak when Anthropic / OpenAI / Google adjust pricing.
export const BLENDED_USD_PER_MTOK: Record<string, { mode: Billing; rate: number }> = {
  // Anthropic API surface (full ID may include date suffix)
  "claude-opus-4-7": { mode: "api", rate: 45 }, // $15 in / $75 out
  "claude-sonnet-4-6": { mode: "api", rate: 9 }, // $3 in / $15 out
  "claude-haiku-4-5": { mode: "api", rate: 2.4 }, // $0.80 in / $4 out
  "claude-sonnet-4-6-20250514": { mode: "api", rate: 9 },
  "claude-haiku-4-5-20251001": { mode: "api", rate: 2.4 },

  // Claude Code CLI variants - same models, but billed via subscription
  "claude-code-opus": { mode: "subscription", rate: 0 },
  "claude-code-sonnet": { mode: "subscription", rate: 0 },
  "claude-code-haiku": { mode: "subscription", rate: 0 },

  // OpenAI
  "gpt-4o": { mode: "api", rate: 6.25 }, // $2.5 in / $10 out
  "gpt-4o-mini": { mode: "api", rate: 0.375 },
  "o3-mini": { mode: "api", rate: 3.6 },

  // Google
  "gemini-2.5-pro": { mode: "api", rate: 3.125 },
  "gemini-2.0-flash": { mode: "api", rate: 0.225 },
};

export const OLLAMA_PREFIXES = ["qwen", "llama", "phi", "gemma", "mistral", "deepseek"];

export function classify(modelId: string): { mode: Billing; rate: number } {
  if (BLENDED_USD_PER_MTOK[modelId]) return BLENDED_USD_PER_MTOK[modelId];

  // Heuristic match for unknown variants
  for (const k of Object.keys(BLENDED_USD_PER_MTOK)) {
    if (modelId.startsWith(k)) return BLENDED_USD_PER_MTOK[k];
  }
  // Ollama-style ids (qwen2.5:7b, llama3.2:3b, etc.)
  for (const p of OLLAMA_PREFIXES) {
    if (modelId.toLowerCase().startsWith(p)) return { mode: "local", rate: 0 };
  }
  return { mode: "api", rate: 0 }; // unknown - show as api with 0 cost
}
