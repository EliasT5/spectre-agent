/**
 * Provider dispatcher — unified streaming interface across all providers.
 *
 * Implementations live in ./providers/*. This file only routes.
 */

import type { Provider } from "./models";
import { PROVIDER_ENV_KEYS, type ChatMessage, type StreamChunk, type StreamOptions, type Streamer } from "./providers/types";

import { streamOpenAI, quickCompleteOpenAI } from "./providers/openai";
import { streamAnthropic, quickCompleteAnthropic } from "./providers/anthropic";
import { streamGoogle, quickCompleteGoogle } from "./providers/google";
import { streamLiteLLM, quickCompleteLiteLLM } from "./providers/litellm";
import { streamClaudeCode, isClaudeCodeAvailable, quickCompleteClaudeCode } from "./providers/claude-code";
import { streamGeminiCli, isGeminiCliAvailable, quickCompleteGeminiCli } from "./providers/gemini-cli";
import { streamCodexCli, isCodexCliAvailable, quickCompleteCodexCli } from "./providers/codex-cli";
import { cliAllowed } from "./cli-gate";
import { streamOllama, isOllamaAvailable, quickCompleteOllama, listOllamaModels } from "./providers/ollama";
import { streamJerome, isJeromeAvailable } from "./providers/jerome";
import { streamCliText } from "./backends/cli-text-streamer";
import { isCliBackendsAllowed } from "./backends/gate";
import { listBackendsSync } from "./backends/registry";

export type { ChatMessage, StreamChunk, StreamOptions } from "./providers/types";

// ── Provider availability ──────────────────────────────────────

/** cli-text is available when the master flag is on AND an enabled cli-command brain exists. */
function cliTextAvailable(): boolean {
  return (
    isCliBackendsAllowed() &&
    listBackendsSync().some((b) => b.kind === "cli-command" && b.enabled && b.roles?.brain)
  );
}

const availableProviders = new Set<Provider>();
let detected = false;
let inflight: Promise<Set<Provider>> | null = null;

export function detectProviders(): Promise<Set<Provider>> {
  // Deduplicate concurrent invocations. Without this, a second caller
  // arriving mid-probe would re-clear() the set and race the first
  // caller's writes — leaving us in a state where `detected=true` but
  // the set is empty, which surfaces as "No AI providers configured"
  // and an empty bubble in chat. Reproduced during deploy churn when
  // multiple requests hit a fresh process simultaneously.
  if (inflight) return inflight;
  inflight = (async () => {
    const next = new Set<Provider>();

    for (const [provider, envVar] of Object.entries(PROVIDER_ENV_KEYS)) {
      if (envVar && process.env[envVar]) {
        next.add(provider as Provider);
      }
    }

    const [claudeOk, geminiOk, codexOk, ollamaOk] = await Promise.all([
      isClaudeCodeAvailable(),
      isGeminiCliAvailable(),
      isCodexCliAvailable(),
      isOllamaAvailable(),
    ]);
    if (claudeOk) next.add("claude-code");
    if (geminiOk) next.add("gemini-cli");
    if (codexOk) next.add("codex-cli");
    if (ollamaOk) {
      next.add("ollama");
      void listOllamaModels(); // warm the sync cache route() reads
    }
    if (cliTextAvailable()) next.add("cli-text");
    // Jerome Mode reuses the Claude Code subscription for its brain, so
    // it\'s available exactly when claude-code is.
    if (await isJeromeAvailable()) next.add("spectre-mode");

    // Atomic swap: clear + repopulate the live Set in one sync block
    // so no synchronous reader (route(), isProviderAvailable) can
    // observe an empty-but-detected state.
    availableProviders.clear();
    for (const p of next) availableProviders.add(p);
    detected = true;
    return availableProviders;
  })();
  return inflight;
}

/**
 * Synchronous availability check. Triggers a background detect on first use,
 * and for local providers returns true if env says we should expect them.
 */
export function isProviderAvailable(provider: Provider): boolean {
  if (!detected) {
    // Fire-and-forget detection; subsequent calls see the real result.
    void detectProviders();
    // Pre-detection defaults. The gated subscription CLIs must NEVER be reported
    // available optimistically — that would advertise (and, for codex/gemini,
    // dispatch into) an opt-in CLI during the detection window. Consult the
    // same SPECTRE_ALLOW_*_CLI gates the real probes use, so the gate is the
    // single source of truth even before the async probe resolves.
    if (provider === "claude-code" || provider === "spectre-mode") return cliAllowed("claude-code");
    if (provider === "gemini-cli") return cliAllowed("gemini-cli");
    if (provider === "codex-cli") return cliAllowed("codex-cli");
    if (provider === "ollama") return true; // local, no ToS gate
    if (provider === "cli-text") return cliTextAvailable();
    const envVar = PROVIDER_ENV_KEYS[provider];
    return !!(envVar && process.env[envVar]);
  }
  return availableProviders.has(provider);
}

export function getAvailableProviders(): Provider[] {
  if (!detected) void detectProviders();
  return [...availableProviders];
}

// ── Streaming dispatch ─────────────────────────────────────────

const streamers: Record<Provider, Streamer> = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  google: streamGoogle,
  litellm: streamLiteLLM,
  "claude-code": streamClaudeCode,
  "gemini-cli": streamGeminiCli,
  "codex-cli": streamCodexCli,
  ollama: streamOllama,
  "spectre-mode": streamJerome,
  "cli-text": streamCliText,
};

export function streamChat(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const provider = opts.model.provider;
  if (!isProviderAvailable(provider)) {
    throw new Error(
      `Provider "${provider}" is not available. ` +
        (PROVIDER_ENV_KEYS[provider]
          ? `Set ${PROVIDER_ENV_KEYS[provider]} in your environment.`
          : `Install/start the local backend.`)
    );
  }
  return streamers[provider](opts);
}

// ── Quick completion ───────────────────────────────────────────

/**
 * Non-streaming short completion (titling, classification).
 * Prefers local + cheap paths: Ollama → gemini-cli → claude-code → OpenAI mini → Haiku → Gemini Flash.
 */
export async function quickComplete(prompt: string): Promise<string> {
  if (!detected) await detectProviders();

  // Try each available provider in order, falling through on runtime failures
  // (detection is cached at startup — a provider may have gone down since then).
  const candidates: Array<() => Promise<string>> = [];
  // The configured standard brain first — it fronts whatever cheap/local model
  // the operator pointed LiteLLM at.
  if (availableProviders.has("litellm")) candidates.push(() => quickCompleteLiteLLM(prompt));
  if (availableProviders.has("ollama")) candidates.push(() => quickCompleteOllama(prompt));
  if (availableProviders.has("gemini-cli")) candidates.push(() => quickCompleteGeminiCli(prompt));
  if (availableProviders.has("claude-code")) candidates.push(() => quickCompleteClaudeCode(prompt));
  if (availableProviders.has("codex-cli")) candidates.push(() => quickCompleteCodexCli(prompt));
  if (availableProviders.has("openai")) candidates.push(() => quickCompleteOpenAI(prompt));
  if (availableProviders.has("anthropic")) candidates.push(() => quickCompleteAnthropic(prompt));
  if (availableProviders.has("google")) candidates.push(() => quickCompleteGoogle(prompt));

  if (candidates.length === 0) throw new Error("No AI providers configured.");

  let lastErr: unknown;
  for (const fn of candidates) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Re-export so `ChatMessage` consumers unaffected
export type { ChatMessage as _ChatMessage } from "./providers/types";

// Call-site compatibility: allow passing a ChatMessage[] to helper
export function messagesToChat(msgs: Array<{ role: string; content: string | null }>): ChatMessage[] {
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content || "" }));
}
