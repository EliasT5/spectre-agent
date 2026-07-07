/**
 * Model catalog — every model Jerome can use, with metadata for routing.
 */

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "litellm"
  | "claude-code"
  | "gemini-cli"
  | "codex-cli"
  | "ollama"
  | "spectre-mode"
  // User-taught cli-command backends selected as a (chat-only) brain. One generic
  // streamer serves all of them; the specific backend id rides ModelDef.cliModel.
  | "cli-text";

export type Capability =
  | "coding"
  | "reasoning"
  | "creative"
  | "general"
  | "vision"
  | "fast"
  | "summarization";

/**
 * Routing intent — produced by router.classifyIntent and matched against
 * each model's `bestFor` list. Lives here (not in router.ts) so the catalog
 * can declare the intents each model excels at without circular imports.
 */
export type Intent =
  | "code_heavy"
  | "code_quick"
  | "reasoning_deep"
  | "creative_long"
  | "summarize"
  | "factual"
  | "vision"
  | "chat";

/**
 * Effort levels for reasoning-capable models (codex/o-series, extended-thinking).
 * Ordered from cheapest to most thorough. A model with `reasoning: true` exposes
 * this list in its `effortLevels` field so the UI can render a slider/picker.
 */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ModelDef {
  id: string;
  provider: Provider;
  displayName: string;
  /** What this model is best at (capability tags) */
  strengths: Capability[];
  /**
   * Intents this model is the strongest pick for. Hard-matched (+30) by the
   * router so a single declaration here moves the auto-route decisively.
   * Be conservative — listing too many intents flattens the signal.
   */
  bestFor: Intent[];
  /** 1 (cheapest) – 5 (most expensive) */
  costTier: number;
  /** 1 (slowest) – 5 (fastest) */
  speed: number;
  /** Max output tokens to request */
  maxOutputTokens: number;
  /** Context window size */
  contextWindow: number;
  /** For provider === "claude-code", "gemini-cli", or "codex-cli": the model ID passed to the CLI. */
  cliModel?: string;
  /**
   * True for models with a dedicated reasoning / extended-thinking mode.
   * When true, `effortLevels` is also populated so the UI can show an effort picker.
   */
  reasoning?: boolean;
  /**
   * Ordered effort levels this model accepts (cheapest → most thorough).
   * Only set when `reasoning === true`.
   */
  effortLevels?: EffortLevel[];
  /**
   * True for CLI-spawned specialist agents that can be dispatched as sub-agents
   * by Jerome Mode (claude-code-*, gemini-cli-*, codex-cli-*). These are the
   * targets the orchestrator can hand a sub-task to.
   */
  orchestratable?: boolean;
}

// ── Model catalog ──────────────────────────────────────────────

export const MODEL_CATALOG: ModelDef[] = [
  // ── Spectre's STANDARD brain: provider-agnostic ──────────
  // One OpenAI-compatible function-calling loop (src/lib/ai/providers/litellm.ts)
  // pointed at SPECTRE_LITELLM_URL — a LiteLLM proxy, Ollama, OpenAI, vLLM,
  // Bedrock, anything. The customer brings their own credentials/models, so it
  // carries no credential dependency (unlike the opt-in claude-code adapter).
  // bestFor lists every intent so it wins auto-routing whenever it's configured;
  // a per-turn model_hint still overrides. The actual model string is
  // SPECTRE_LITELLM_MODEL (env), so this single entry fronts any backing model.
  {
    id: "litellm-default",
    provider: "litellm",
    displayName: "LiteLLM gateway (default model)",
    strengths: ["general", "reasoning", "coding", "creative", "summarization", "fast"],
    bestFor: [
      "chat",
      "code_heavy",
      "code_quick",
      "reasoning_deep",
      "creative_long",
      "summarize",
      "factual",
    ],
    costTier: 3,
    speed: 3,
    maxOutputTokens: 8192,
    contextWindow: 128_000,
  },

  // Jerome Mode — multi-model orchestrator. Brain decides which specialist
  // model handles each sub-step of a request and chains them together.
  // Three brain tiers: Haiku (fast), Sonnet (medium), Opus (pro).
  {
    id: "jerome-fast",
    provider: "spectre-mode",
    displayName: "Jerome Fast",
    strengths: ["general", "fast"],
    bestFor: ["chat", "factual", "summarize"],
    costTier: 2,
    speed: 4,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
  },
  {
    id: "jerome-medium",
    provider: "spectre-mode",
    displayName: "Jerome Medium",
    strengths: ["general", "reasoning", "coding"],
    bestFor: ["chat", "code_quick", "creative_long"],
    costTier: 3,
    speed: 3,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
  },
  {
    id: "jerome-pro",
    provider: "spectre-mode",
    displayName: "Jerome Pro",
    strengths: ["reasoning", "coding", "creative", "general"],
    bestFor: ["reasoning_deep", "code_heavy"],
    costTier: 5,
    speed: 2,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
  },

  // ── CLI subscription models ───────────────────────────────
  // CLIs expose no "/v1/models" endpoint — these names are maintained manually.
  // To add or remove a CLI model, edit this block (one line per entry).
  // Availability is gate-checked at runtime via SPECTRE_ALLOW_*_CLI env vars
  // + binary detection; the models are always included in the response but
  // marked available:false when the gate is off or the CLI is not found.

  // Claude Code (subscription, via local CLI)
  {
    id: "claude-code-haiku",
    provider: "claude-code",
    cliModel: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    strengths: ["fast", "general", "summarization"],
    bestFor: ["factual", "summarize"],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 4096,
    contextWindow: 200_000,
    orchestratable: true,
  },
  {
    id: "claude-code-sonnet",
    provider: "claude-code",
    cliModel: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    strengths: ["coding", "reasoning", "creative", "general"],
    bestFor: ["code_heavy", "code_quick", "creative_long", "chat"],
    costTier: 3,
    speed: 4,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
    orchestratable: true,
  },
  {
    id: "claude-code-opus",
    provider: "claude-code",
    cliModel: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    strengths: ["reasoning", "coding", "creative"],
    bestFor: ["reasoning_deep", "code_heavy", "creative_long"],
    costTier: 5,
    speed: 2,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
    orchestratable: true,
  },

  // Codex CLI (OpenAI agentic coder, via local CLI — requires ChatGPT Plus)
  {
    id: "codex-cli-mini",
    provider: "codex-cli",
    cliModel: "gpt-5.4-mini",
    displayName: "GPT 5.4 Mini",
    strengths: ["coding", "fast", "general"],
    bestFor: ["code_quick"],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 4096,
    contextWindow: 128_000,
    reasoning: true,
    effortLevels: [...EFFORT_LEVELS],
    orchestratable: true,
  },
  {
    id: "codex-cli-gpt55",
    provider: "codex-cli",
    cliModel: "gpt-5.5",
    displayName: "GPT 5.5",
    strengths: ["coding", "reasoning", "general"],
    bestFor: ["reasoning_deep", "code_heavy"],
    costTier: 3,
    speed: 4,
    maxOutputTokens: 8192,
    contextWindow: 128_000,
    reasoning: true,
    effortLevels: [...EFFORT_LEVELS],
    orchestratable: true,
  },
  {
    id: "codex-cli-codex",
    provider: "codex-cli",
    cliModel: "gpt-5.3-codex",
    displayName: "GPT 5.3 Codex",
    strengths: ["coding", "reasoning"],
    bestFor: ["code_heavy"],
    costTier: 2,
    speed: 3,
    maxOutputTokens: 8192,
    contextWindow: 128_000,
    reasoning: true,
    effortLevels: [...EFFORT_LEVELS],
    orchestratable: true,
  },

  // Gemini CLI (autonomous agent, via local CLI)
  {
    id: "gemini-cli-flash",
    provider: "gemini-cli",
    cliModel: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    strengths: ["fast", "general", "summarization"],
    bestFor: ["factual", "summarize"],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 8192,
    contextWindow: 1_000_000,
    orchestratable: true,
  },
  {
    id: "gemini-cli-pro",
    provider: "gemini-cli",
    cliModel: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro",
    strengths: ["coding", "reasoning", "creative", "general", "vision"],
    bestFor: ["vision", "reasoning_deep", "creative_long"],
    costTier: 4,
    speed: 3,
    maxOutputTokens: 8192,
    contextWindow: 1_000_000,
    orchestratable: true,
  },
  {
    id: "gemini-cli-auto",
    provider: "gemini-cli",
    cliModel: "auto-gemini-3",
    displayName: "Gemini 3 Auto",
    strengths: ["coding", "reasoning", "creative"],
    bestFor: ["chat"],
    costTier: 3,
    speed: 4,
    maxOutputTokens: 8192,
    contextWindow: 1_000_000,
    orchestratable: true,
  },

  // Ollama (local open-source models — seed entries; live list is merged at runtime)
  {
    id: "qwen2.5:7b-instruct",
    provider: "ollama",
    displayName: "Qwen 2.5 7B",
    strengths: ["coding", "general", "reasoning"],
    bestFor: [],
    costTier: 1,
    speed: 3,
    maxOutputTokens: 4096,
    contextWindow: 32_000,
  },
  {
    id: "llama3.2:3b",
    provider: "ollama",
    displayName: "Llama 3.2 3B",
    strengths: ["fast", "general", "summarization"],
    bestFor: [],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 2048,
    contextWindow: 128_000,
  },

  // OpenAI API — seed entries; live list is fetched from GET /v1/models when
  // OPENAI_API_KEY is set. o-series models support reasoning effort control.
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    strengths: ["general", "creative", "vision", "reasoning"],
    bestFor: [],
    costTier: 3,
    speed: 4,
    maxOutputTokens: 4096,
    contextWindow: 128_000,
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o Mini",
    strengths: ["general", "fast", "summarization"],
    bestFor: [],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 4096,
    contextWindow: 128_000,
  },
  {
    id: "o3-mini",
    provider: "openai",
    displayName: "o3 Mini",
    strengths: ["reasoning", "coding"],
    bestFor: [],
    costTier: 2,
    speed: 3,
    maxOutputTokens: 4096,
    contextWindow: 128_000,
    reasoning: true,
    effortLevels: ["low", "medium", "high"],
  },

  // Anthropic API — seed entries; live list is fetched from GET /v1/models when
  // ANTHROPIC_API_KEY is set.
  {
    id: "claude-sonnet-4-6-20250514",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.6",
    strengths: ["coding", "reasoning", "creative", "general"],
    bestFor: [],
    costTier: 3,
    speed: 4,
    maxOutputTokens: 8192,
    contextWindow: 200_000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    strengths: ["fast", "general", "summarization", "coding"],
    bestFor: [],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 4096,
    contextWindow: 200_000,
  },

  // Google API — seed entries; live list is fetched from the Generative Language
  // API when GOOGLE_GENAI_API_KEY is set.
  {
    id: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    strengths: ["reasoning", "coding", "general", "vision"],
    bestFor: [],
    costTier: 3,
    speed: 3,
    maxOutputTokens: 8192,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-2.0-flash",
    provider: "google",
    displayName: "Gemini 2.0 Flash",
    strengths: ["fast", "general", "summarization", "vision"],
    bestFor: [],
    costTier: 1,
    speed: 5,
    maxOutputTokens: 4096,
    contextWindow: 1_000_000,
  },
];

/** Quick lookup */
export function getModel(id: string): ModelDef | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
