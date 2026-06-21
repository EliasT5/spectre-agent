/**
 * Jerome Mode v2 — multi-model orchestrator backed by MCP tool calls.
 *
 * The brain (Haiku/Sonnet/Opus, depending on tier) is spawned as a normal
 * Claude turn but with a custom MCP broker that exposes ONE tool:
 * `dispatch_to_model`. All built-in claude tools are disallowed, so the
 * brain\'s only available capability is "route a sub-task to a
 * specialist". This is far more reliable than asking the model to emit
 * structured JSON in plain text — Claude treats tool calls as native.
 *
 * Each tool call surfaces as a `tool_use` chunk on the stream; we rewrite
 * the chip name from `mcp__spectre_mode__dispatch_to_model` to
 * `→ <ModelDisplayName> · <role>` for the chat UI. The accompanying
 * `tool_result` is the specialist\'s response, dispatched server-side
 * (see /api/spectre-mode/dispatch). Brain text streams through normally,
 * so the user sees the brain reasoning live.
 *
 * Step budget: read from app_config.jerome_max_steps. We can\'t hard-limit
 * inside the broker (each call goes through it), but we tell the brain
 * via system prompt and trust it; if it overruns we let it run to
 * Claude\'s own iteration cap.
 */

import { MODEL_CATALOG, type ModelDef } from "../models";
import type { StreamChunk, StreamOptions } from "./types";
import { createHash } from "crypto";

const BRAIN_BY_MODE: Record<string, string> = {
  "jerome-fast": "claude-code-haiku",
  "jerome-medium": "claude-code-sonnet",
  "jerome-pro": "claude-code-opus",
};

const AUTO_STEP_CAP: Record<string, number> = {
  "jerome-fast": 4,
  "jerome-medium": 6,
  "jerome-pro": 10,
};

const HARD_STEP_CEILING = 16;

const DISPATCH_TOOL_NAME_RE = /(?:^|__)dispatch_to_model$/;

const DISPATCHABLE_MODEL_IDS = [
  "claude-code-haiku",
  "claude-code-sonnet",
  "claude-code-opus",
  "gemini-cli-flash",
  "gemini-cli-pro",
  "gemini-cli-auto",
  "codex-cli-mini",
  "codex-cli-gpt55",
  "codex-cli-codex",
];

function brainSessionIdForThread(threadId: string | undefined): string | undefined {
  if (!threadId) return undefined;
  const bytes = createHash("sha1")
    .update(`${threadId}:brain`)
    .digest()
    .subarray(0, 16);

  // Shape the deterministic hash as an RFC 4122 version-5 UUID so Claude's
  // CLI accepts it as a persistent session id.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function buildOrchestratorPrompt(
  stepBudget: number,
  soulPrompt: string,
  /** null = all targets; a Set restricts to only those IDs */
  allowedTargets: Set<string> | null,
): string {
  const activeIds = allowedTargets
    ? DISPATCHABLE_MODEL_IDS.filter((id) => allowedTargets.has(id))
    : DISPATCHABLE_MODEL_IDS;
  const dispatchableList = activeIds
    .map((id) => MODEL_CATALOG.find((m) => m.id === id))
    .filter((m): m is ModelDef => !!m)
    .map(
      (m) =>
        `  - ${m.id} (${m.displayName}): strengths=${m.strengths.join(",")}, costTier=${m.costTier}, speed=${m.speed}`
    )
    .join("\n");

  return `${soulPrompt}

---

JEROME MODE — multi-model orchestration

You are the orchestrator. The user message arrives in the conversation as
usual. You can use Jerome MCP tools for memory, retrieval, local context,
and other brokered capabilities. You also have \`dispatch_to_model\`; use it
to delegate sub-tasks to specialist models when a different model fits better
than you. When you have enough information, write the final answer for the
user as your normal text response — do NOT call dispatch_to_model again.

Default execution loop:
1. Decompose the user's request internally before acting. Identify the real
   deliverable, required facts/assets, possible tools, and the shortest path
   to a finished answer.
2. Decide whether the work should be handled by you, a Jerome MCP tool, one
   or more specialist dispatches, or a combination. Do not dispatch merely
   because a task sounds broad; dispatch only when the expert's output is
   needed to reach the deliverable.
3. Execute the chosen path. Await each tool or specialist result before
   depending on it. If an expert result is empty, timed out, or irrelevant,
   recover by choosing a better tool/model or by explaining the concrete
   failure.
4. Synthesize the results yourself. The final answer must be yours, not a raw
   paste of a specialist response.
5. Keep the user's UI calm: state at most one short visible plan sentence
   before tools, then use tool calls silently, then provide the result.

Do not expose long chain-of-thought. You may briefly state the plan or
decision, but keep the detailed decomposition internal unless the user asks for
it explicitly.

Available specialist models (use with dispatch_to_model.model):
${dispatchableList}

Routing heuristics:
- Image generation is NOT a specialist dispatch task. For requests to create,
  generate, draw, render, or imagine an image/portrait/mockup, call
  \`mcp__spectre__openai_image\` directly and embed the returned
  \`/generated/...\` URL in the final answer. Do NOT use
  \`dispatch_to_model\` for image generation.
- Gemini's "vision" strength means image/document understanding, not image
  creation in this architecture.
- Check memory when the user asks you to remember, recall, continue prior
  context, or use known personal/project facts.
- Rely on your own intelligence for simple turns; only fan out when a
  specialist materially improves speed, quality, or coverage.
- Use the cheapest model that can plausibly do each sub-task.
- Gemini 3 Pro: long-context research, multi-modal, very large docs.
- GPT 5.5 / GPT 5.3 Codex: heavy coding, tricky algorithms.
- Sonnet: balanced verification or general reasoning.
- Haiku / Gemini Flash: cheap summaries, factual lookups, classification.
- Dispatch independent sub-tasks in parallel when possible by making multiple
  dispatch_to_model calls in the same assistant step.
- Cross-verify only when correctness genuinely matters; do not loop.
- Each dispatch prompt MUST be self-contained — embed the user's context,
  prior tool outputs, file snippets, etc. The specialist sees nothing else.

Step budget: aim for at most ${stepBudget} dispatches per turn before
finalising. After that, stop calling the tool and write the answer.
DO NOT call dispatch_to_model with model=jerome-* (would recurse).

Open with one short sentence stating the execution path you chose, then run
the necessary tools/dispatches silently, then close with the finished answer
and only the relevant summary of what happened.`;
}

async function getMaxStepsSetting(): Promise<string> {
  try {
    const { createServiceSupabase } = await import("@/lib/supabase/server");
    const supabase = createServiceSupabase();
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "jerome_max_steps")
      .maybeSingle();
    if (data?.value && typeof data.value === "string") return data.value;
  } catch {
    /* fall through */
  }
  return "auto";
}

/**
 * Read `orchestration_targets` from app_config.
 * Returns null when absent/empty (means all targets allowed).
 * Returns a Set<string> of allowed model IDs when configured.
 */
async function getOrchestrationTargets(): Promise<Set<string> | null> {
  try {
    const { createServiceSupabase } = await import("@/lib/supabase/server");
    const supabase = createServiceSupabase();
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "orchestration_targets")
      .maybeSingle();
    if (data?.value && typeof data.value === "string" && data.value.trim() !== "") {
      const ids = data.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) return new Set(ids);
    }
  } catch {
    /* fall through */
  }
  return null;
}

function resolveStepLimit(setting: string, modeId: string): number {
  const fallback = AUTO_STEP_CAP[modeId] ?? 6;
  if (setting === "auto") return fallback;
  const n = parseInt(setting, 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, HARD_STEP_CEILING);
  return fallback;
}

export async function* streamJerome(
  opts: StreamOptions
): AsyncGenerator<StreamChunk> {
  const brainId = BRAIN_BY_MODE[opts.model.id];
  if (!brainId) throw new Error(`Unknown jerome mode: ${opts.model.id}`);

  const brainModel = MODEL_CATALOG.find((m) => m.id === brainId);
  if (!brainModel) {
    throw new Error(`Jerome Mode: brain "${brainId}" not in catalog`);
  }

  const [stepSetting, allowedTargets] = await Promise.all([
    getMaxStepsSetting(),
    getOrchestrationTargets(),
  ]);
  const stepLimit = resolveStepLimit(stepSetting, opts.model.id);

  const orchestratorSystem = buildOrchestratorPrompt(
    stepLimit,
    opts.system ?? "",
    allowedTargets,
  );

  // Give the orchestrator its own stable Claude session. Claude's CLI only
  // accepts UUID-shaped session ids, so derive one deterministically from
  // the thread id instead of suffixing the thread UUID with text.
  const brainSessionId = brainSessionIdForThread(opts.threadId);

  // Lazy import to avoid the providers.ts <-> jerome.ts module cycle.
  const { streamChat } = await import("../providers");

  const brainStream = streamChat({
    model: brainModel,
    system: orchestratorSystem,
    messages: opts.messages,
    threadId: brainSessionId,
    planMode: false,
    jeromeMode: true,
  });

  let totalIn = 0;
  let totalOut = 0;
  let dispatchCount = 0;

  for await (const chunk of brainStream) {
    if (chunk.type === "tool_use" && DISPATCH_TOOL_NAME_RE.test(chunk.name)) {
      dispatchCount += 1;
      const input =
        chunk.input && typeof chunk.input === "object"
          ? (chunk.input as Record<string, unknown>)
          : {};
      const targetId = typeof input.model === "string" ? input.model : "?";
      const role = typeof input.role === "string" ? input.role : "";
      const target = MODEL_CATALOG.find((m) => m.id === targetId);
      const display = target?.displayName ?? targetId;
      yield {
        type: "tool_use",
        id: chunk.id,
        name: role ? `→ ${display} · ${role}` : `→ ${display}`,
        input: chunk.input,
      };
      continue;
    }

    if (chunk.type === "done") {
      totalIn += chunk.inputTokens ?? 0;
      totalOut += chunk.outputTokens ?? 0;
      // Re-emit done with our own model id so the chat header shows
      // the Jerome Mode tier rather than the underlying brain.
      yield {
        type: "done",
        model: opts.model.id,
        inputTokens: totalIn,
        outputTokens: totalOut,
      };
      continue;
    }

    yield chunk;
  }
  void dispatchCount; // currently informational; future: enforce hard cap.
}

export async function isJeromeAvailable(): Promise<boolean> {
  const { isClaudeCodeAvailable } = await import("./claude-code");
  return await isClaudeCodeAvailable();
}

export async function quickCompleteJerome(prompt: string): Promise<string> {
  const { quickCompleteClaudeCode } = await import("./claude-code");
  return quickCompleteClaudeCode(prompt);
}
