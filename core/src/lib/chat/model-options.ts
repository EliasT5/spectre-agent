
/**
 * Model options surfaced in the chat header picker. Grouped visually
 * by `group` (rendered as section dividers in the menu). The empty
 * id "" maps to model_hint=null on the backend → router auto-routes
 * by intent.
 */
export const MODEL_OPTIONS: Array<{ id: string; label: string; group?: string }> = [
  { id: "",                            label: "Auto-route by intent",        group: "auto" },
  // Jerome Mode — multi-model orchestrator (brain dispatches to specialists)
  { id: "jerome-fast",                 label: "Jerome Fast · Haiku brain",   group: "jerome" },
  { id: "jerome-medium",               label: "Jerome Medium · Sonnet brain",group: "jerome" },
  { id: "jerome-pro",                  label: "Jerome Pro · Opus brain",     group: "jerome" },
  // Claude Code (subscription via local CLI)
  { id: "claude-code-haiku",           label: "Haiku 4.5 · fast",            group: "claude" },
  { id: "claude-code-sonnet",          label: "Sonnet 4.6 · default",        group: "claude" },
  { id: "claude-code-opus",            label: "Opus 4.7 · deep",             group: "claude" },
  // Gemini CLI (local)
  { id: "gemini-cli-flash",            label: "Gemini 2.5 Flash · fast",     group: "gemini" },
  { id: "gemini-cli-auto",             label: "Gemini 3 Auto · default",     group: "gemini" },
  { id: "gemini-cli-pro",              label: "Gemini 3 Pro · deep",       group: "gemini" },
  // Codex CLI (ChatGPT Plus)
  { id: "codex-cli-mini",              label: "GPT 5.4 Mini · fast",         group: "codex" },
  { id: "codex-cli-gpt55",             label: "GPT 5.5 · smart",             group: "codex" },
  { id: "codex-cli-codex",             label: "GPT 5.3 Codex · code",        group: "codex" },
  // Ollama (local OSS)
  { id: "llama3.2:3b",                 label: "Llama 3.2 3B · local fast",   group: "ollama" },
  { id: "qwen2.5:7b-instruct",         label: "Qwen 2.5 7B · local default", group: "ollama" },
  // OpenAI API (fallback, requires OPENAI_API_KEY)
  { id: "gpt-4o-mini",                 label: "GPT-4o Mini · API",           group: "openai-api" },
  { id: "gpt-4o",                      label: "GPT-4o · API",                group: "openai-api" },
  { id: "o3-mini",                     label: "o3 Mini · API reasoning",     group: "openai-api" },
  // Anthropic API (fallback, requires ANTHROPIC_API_KEY)
  { id: "claude-haiku-4-5-20251001",   label: "Haiku 4.5 · API",             group: "anthropic-api" },
  { id: "claude-sonnet-4-6-20250514",  label: "Sonnet 4.6 · API",            group: "anthropic-api" },
  // Google API (fallback, requires GOOGLE_GENAI_API_KEY)
  { id: "gemini-2.0-flash",            label: "Gemini 2.0 Flash · API",      group: "google-api" },
  { id: "gemini-2.5-pro",              label: "Gemini 2.5 Pro · API",        group: "google-api" },
];

/**
 * Model IDs that support a `reasoning_effort` parameter. When one of these
 * is the active model, callers should surface an effort dropdown next to
 * the model picker.
 */
export const REASONING_MODELS = new Set([
  "codex-cli-mini",
  "codex-cli-gpt55",
  "codex-cli-codex",
  "o3-mini",
]);

export const EFFORT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "",        label: "default"  },
  { id: "minimal", label: "minimal" },
  { id: "low",     label: "low"     },
  { id: "medium",  label: "medium"  },
  { id: "high",    label: "high"    },
  { id: "xhigh",   label: "xhigh"   },
];
