/**
 * SkillOpt rollout — the headless generation primitive.
 *
 * Runs the FROZEN multi-model brain against a single task input, with ONLY a
 * candidate skill doc injected into the system prompt. It is the
 * optimization-free half of SkillOpt Step 1: prove we can drive the real brain
 * headlessly and read back a deterministic output + token usage, with no
 * optimization loop attached yet.
 *
 * Purity guarantees (this is the whole point):
 *   - System prompt = buildSystemPrompt({ skills: [candidate] }) ONLY. No
 *     recall block, no monitor-issues block, no cross-thread block — none of
 *     the per-turn DB context the live run/route.ts handler stitches on. The
 *     reward must measure the SKILL, not Jerome's memory of past games.
 *   - No threadId. For the claude-code provider this means no MCP broker, no
 *     persistent session marker, no resume — just `--system-prompt` + the one
 *     user message. So learnFromExchange / durable-chat / Supabase writes can
 *     never fire: this function never touches the route handler or the DB.
 *   - The model is PINNED (frozen), never auto-routed by message content, so
 *     every rollout in an optimization sweep is comparable.
 *
 * Model-agnostic: streamChat dispatches by provider, and every provider emits
 * the same { type:"token" } / { type:"done", inputTokens, outputTokens } shape,
 * so this drains uniformly for claude-code / api / ollama / gemini / codex.
 */

import { streamChat } from "./providers";
import { route } from "./router";
import { getModel, type ModelDef } from "./models";
import { buildSystemPrompt } from "./soul";

/**
 * Default frozen model for rollouts: the provider-agnostic brain (LiteLLM),
 * not the opt-in Claude CLI. litellm-default fronts whatever the operator's
 * SPECTRE_LITELLM_MODEL points at, so sweeps run on the same
 * bring-your-own-credentials path as the rest of Spectre. A caller can still pin
 * any catalog id via opts.modelId (incl. a CLI model on a personal Claude build).
 */
const DEFAULT_ROLLOUT_MODEL = "litellm-default";

export interface RolloutOptions {
  /** Name of the skill under optimization (becomes "## Skill: <name>"). */
  skillName: string;
  /** The candidate skill document to inject (the SKILL.md body being scored). */
  skillDoc: string;
  /** The task prompt sent as the single user turn (e.g. a FEN + ask-for-move). */
  taskInput: string;
  /**
   * Explicit model to pin. Defaults to a sensible non-Haiku model. Passed to
   * route() as a hint; if the hinted id is unavailable we still pin it directly
   * (the rollout must be frozen — we never silently auto-route on task text).
   */
  modelId?: string;
}

export interface RolloutResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Resolve the frozen model. route() honours a matching available-model id
 * verbatim; if the hint is unavailable it falls through to content-based auto
 * routing, which would break the "frozen + comparable" contract. So if route()
 * didn't hand back the requested id, pin the catalog entry directly instead.
 */
function resolveFrozenModel(requested: string): ModelDef {
  const routed = route("", requested).model;
  if (routed.id === requested) return routed;
  const direct = getModel(requested);
  if (direct) return direct;
  // Requested model isn't in the catalog at all — fall back to the routed pick
  // so the caller still gets a deterministic, frozen model rather than an error.
  return routed;
}

export async function rollout(opts: RolloutOptions): Promise<RolloutResult> {
  const modelId = opts.modelId ?? DEFAULT_ROLLOUT_MODEL;
  const model = resolveFrozenModel(modelId);

  // ONLY the candidate skill — no recall / issues / cross-thread blocks. This
  // is the rollout isolation that kills the all-skills attribution noise.
  const system = buildSystemPrompt({
    skills: [{ name: opts.skillName, content: opts.skillDoc }],
  });

  // No threadId → DB-free, broker-free, session-free generation.
  const chunks = streamChat({
    model,
    system,
    messages: [{ role: "user", content: opts.taskInput }],
  });

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finalModel = model.id;

  for await (const chunk of chunks) {
    if (chunk.type === "token" && chunk.text) {
      text += chunk.text;
    } else if (chunk.type === "done") {
      finalModel = chunk.model ?? model.id;
      inputTokens = chunk.inputTokens ?? 0;
      outputTokens = chunk.outputTokens ?? 0;
    }
    // tool_use / tool_result chunks are inert here: with no threadId the
    // claude-code provider doesn't attach the broker, so no tools are exposed.
  }

  return { text: text.trim(), inputTokens, outputTokens, model: finalModel };
}
