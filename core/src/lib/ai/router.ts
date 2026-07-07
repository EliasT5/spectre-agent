/**
 * Smart model router — picks the best available model for the task.
 *
 * Strategy:
 *   1. If a model_hint is supplied (per-turn body or thread-locked pin or
 *      app_config default), honour it verbatim.
 *   2. classifyIntent inspects the message shape + keywords to pick one of
 *      8 intents (see Intent in models.ts).
 *   3. scoreModel ranks every available model:
 *        +30  if the intent is in the model's `bestFor` list (hard match)
 *        +10  per capability strength that the intent wants (soft match)
 *        + speed   for time-critical intents (factual/summarize/chat/code_quick)
 *        + costTier for analytical intents (proxy for compute intensity)
 *        + 1   tiny nudge for local CLI providers (subscription, no per-call $)
 *   4. The highest scorer wins.
 *
 * Why the redesign vs the old `+12 to every claude-code model` bias:
 *   - That bias collapsed every auto-route to a Claude-Code model regardless
 *     of task fit, so Gemini and Codex were effectively dead in the catalog.
 *   - Per-model `bestFor` lists let each provider win where it actually
 *     excels (Gemini Pro for vision, Codex for heavy coding, Opus for
 *     reasoning, Haiku for snappy lookups, etc).
 */

import { MODEL_CATALOG, type Intent, type ModelDef } from "./models";
import { isProviderAvailable } from "./providers";
import { getBackendSync } from "./backends/registry";
import { ollamaModelsSync } from "./providers/ollama";

export type { Intent } from "./models";

// ── Intent classification ──────────────────────────────────────

const HAS_CODE_BLOCK = /```/;
const FILE_PATH_HINT = /\b[\w./-]+\.(?:tsx?|jsx?|py|rs|go|java|cpp?|cc|hh?|hpp|md|json|ya?ml|sh|sql|html?|css|scss|toml|ini|env)\b/i;
const STACK_TRACE = /\bat\s+[\w.<>$]+\s*\(/;

const KEYWORDS_REASONING =
  /\b(why|explain|analyze|analyse|compare|evaluate|trade-?offs?|prove|proof|reason(?:ing)?|step.by.step|deep.dive|break.down|plan(?:ning)?)\b/i;
const KEYWORDS_CREATIVE_LONG =
  /\b(write|draft|compose).{0,40}\b(story|essay|article|blog|post|chapter|proposal|pitch|speech|letter|tagline|copy|landing)\b/i;
const KEYWORDS_SUMMARIZE =
  /\b(summari[sz]e|summary|tldr|tl;dr|recap|key\s+points|distill|condense)\b/i;
const KEYWORDS_FACTUAL =
  /\b(what\s+is|who\s+is|when\s+(?:did|was)|where\s+is|how\s+much|how\s+many|define|definition\s+of)\b/i;
const KEYWORDS_VISION =
  /\b(this\s+image|attached\s+(?:image|screenshot)|in\s+the\s+(?:image|picture|photo|screenshot)|describe\s+(?:the\s+)?(?:image|picture|photo|screenshot))\b/i;
const KEYWORDS_CODE =
  /\b(function|class|method|component|module|api|endpoint|bug|error|exception|crash|stack\s*trace|debug|refactor|implement|deploy|docker|build|compile|unit\s+test|fix\s+(?:the|a|this)?\s*(?:bug|issue|error|test)|typescript|javascript|python|rust|go(?:lang)?|swift|kotlin|java|sql|regex|css|html|tailwind|react|vue|angular|next\.?js|node|fastapi|django|flask|rails|spring)\b/i;

export function classifyIntent(message: string): Intent {
  const trimmed = message.trim();
  const len = trimmed.length;

  // Vision wins early — if the user explicitly references an image, only a
  // vision-capable model will help, regardless of any other signal.
  if (KEYWORDS_VISION.test(trimmed)) return "vision";

  // Summarize is unambiguous and dominates other signals (a "tldr the
  // function" is still a summarize task, not a coding one).
  if (KEYWORDS_SUMMARIZE.test(trimmed)) return "summarize";

  const hasCode =
    HAS_CODE_BLOCK.test(trimmed) ||
    FILE_PATH_HINT.test(trimmed) ||
    STACK_TRACE.test(trimmed) ||
    KEYWORDS_CODE.test(trimmed);

  if (hasCode) {
    // Heavy: anything with a code block, a stack trace, or a long prompt
    // (multi-file context, architecture, refactor). Quick: short snippet
    // questions like "how do I X in TypeScript".
    return HAS_CODE_BLOCK.test(trimmed) || STACK_TRACE.test(trimmed) || len > 280
      ? "code_heavy"
      : "code_quick";
  }

  if (KEYWORDS_CREATIVE_LONG.test(trimmed)) return "creative_long";

  if (KEYWORDS_REASONING.test(trimmed)) {
    // Long reasoning prompts get the deep-thinking models; one-liners that
    // happen to contain "explain" probably just want a quick answer.
    return len > 200 ? "reasoning_deep" : "chat";
  }

  if (KEYWORDS_FACTUAL.test(trimmed) || (len < 60 && trimmed.endsWith("?"))) {
    return "factual";
  }

  return "chat";
}

// ── Scoring ────────────────────────────────────────────────────

interface IntentProfile {
  /** Capability strengths this intent rewards (soft match). */
  want: string[];
  /** Tie-break preference: speed for time-critical, quality for analytical. */
  prefer: "speed" | "quality";
}

const intentProfile: Record<Intent, IntentProfile> = {
  code_heavy:     { want: ["coding", "reasoning"],     prefer: "quality" },
  code_quick:     { want: ["coding", "fast"],          prefer: "speed"   },
  reasoning_deep: { want: ["reasoning"],               prefer: "quality" },
  creative_long:  { want: ["creative", "general"],     prefer: "quality" },
  summarize:      { want: ["summarization", "fast"],   prefer: "speed"   },
  factual:        { want: ["fast", "general"],         prefer: "speed"   },
  vision:         { want: ["vision"],                  prefer: "quality" },
  chat:           { want: ["general", "fast"],         prefer: "speed"   },
};

function scoreModel(model: ModelDef, intent: Intent): number {
  const profile = intentProfile[intent];
  let score = 0;

  if (model.bestFor?.includes(intent)) score += 30;

  for (const cap of profile.want) {
    if (model.strengths.includes(cap as ModelDef["strengths"][number])) score += 10;
  }

  if (profile.prefer === "speed") score += model.speed;
  else score += model.costTier;

  // Local-CLI providers bypass per-call API billing; small nudge so they win
  // ties against API peers when both are configured. Not enough to override
  // a real `bestFor` match elsewhere.
  if (
    model.provider === "claude-code" ||
    model.provider === "gemini-cli" ||
    model.provider === "codex-cli"
  ) {
    score += 1;
  }

  return score;
}

// ── Router ─────────────────────────────────────────────────────

export interface RouteResult {
  model: ModelDef;
  intent: Intent;
  reason: string;
}

export function route(message: string, modelHint?: string | null): RouteResult {
  const available = MODEL_CATALOG.filter((m) => isProviderAvailable(m.provider));

  if (available.length === 0) {
    throw new Error("No AI providers configured. Set at least one API key.");
  }

  if (modelHint) {
    // Explicit "route through the gateway (agentic/tools)" request — the "· tools"
    // picker variant of a local model. `gateway:<model>` forces the LiteLLM path so
    // the model runs the tool loop, even though the bare id would go to Ollama.
    if (modelHint.startsWith("gateway:") && isProviderAvailable("litellm")) {
      const bare = modelHint.slice("gateway:".length);
      return {
        model: {
          id: modelHint,
          provider: "litellm",
          cliModel: bare,
          displayName: `${bare} (tools)`,
          strengths: ["general", "reasoning", "coding"],
          bestFor: [],
          costTier: 3,
          speed: 3,
          maxOutputTokens: 8192,
          contextWindow: 128_000,
        },
        intent: "chat",
        reason: `Gateway (tools) ${bare}`,
      };
    }
    const hinted = available.find((m) => m.id === modelHint);
    if (hinted) {
      return {
        model: hinted,
        intent: "chat",
        reason: `User selected ${hinted.displayName}`,
      };
    }
    // A user-taught cli-command backend selected as a brain (chat-only text CLI).
    // Checked BEFORE the litellm catch-all, which would otherwise claim any hint.
    const backend = getBackendSync(modelHint);
    if (
      backend &&
      backend.kind === "cli-command" &&
      backend.roles?.brain &&
      backend.enabled &&
      isProviderAvailable("cli-text")
    ) {
      return {
        model: {
          id: modelHint,
          provider: "cli-text",
          cliModel: backend.id,
          displayName: backend.label,
          strengths: ["general"],
          bestFor: [],
          costTier: 2,
          speed: 3,
          maxOutputTokens: 4096,
          contextWindow: backend.contextWindow ?? 32_000,
        },
        intent: "chat",
        reason: `CLI backend ${backend.label}`,
      };
    }
    // A live Ollama model pulled locally → the fast, tool-less ollama provider.
    // Checked BEFORE the litellm catch-all so local models aren't sent to the
    // gateway (which may not know them, and injects tool schemas that tool-less
    // models like gemma3 reject with "does not support tools").
    if (isProviderAvailable("ollama") && ollamaModelsSync().includes(modelHint)) {
      return {
        model: {
          id: modelHint,
          provider: "ollama",
          displayName: modelHint,
          strengths: ["general"],
          bestFor: [],
          costTier: 1,
          speed: 3,
          maxOutputTokens: 4096,
          contextWindow: 32_000,
        },
        intent: "chat",
        reason: `Ollama model ${modelHint}`,
      };
    }
    // Not in the static catalog — but if LiteLLM is configured, the hint may be a
    // model the gateway exposes (auto-detected from /v1/models or runtime-added
    // via Settings → Providers). Honour it with a synthetic litellm ModelDef so
    // ANY provider added to the proxy is selectable with no code change.
    if (isProviderAvailable("litellm")) {
      return {
        model: {
          id: modelHint,
          provider: "litellm",
          cliModel: modelHint,
          displayName: modelHint,
          strengths: ["general", "reasoning", "coding"],
          bestFor: [],
          costTier: 3,
          speed: 3,
          maxOutputTokens: 8192,
          contextWindow: 128_000,
        },
        intent: "chat",
        reason: `LiteLLM model ${modelHint}`,
      };
    }
    // Hint references an unavailable model — fall through to auto.
  }

  const intent = classifyIntent(message);
  const scored = available
    .map((m) => ({ model: m, score: scoreModel(m, intent) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    model: best.model,
    intent,
    reason: `${intent} → ${best.model.displayName} (score ${best.score})`,
  };
}
