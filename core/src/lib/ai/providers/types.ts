import type { ModelDef, Provider } from "../models";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export type StreamChunk =
  | { type: "token"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      output: unknown;
      isError?: boolean;
    }
  | {
      type: "done";
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    };

export interface StreamOptions {
  model: ModelDef;
  system: string;
  messages: ChatMessage[];
  /**
   * Char offset into `system` marking the end of the STABLE prefix (soul +
   * skills index). Providers that support prompt caching (litellm → Anthropic)
   * put a cache breakpoint here; the volatile per-turn context (memory recall,
   * issues, PDF hits) lives after it. 0/undefined = no split.
   */
  cacheBreak?: number;
  maxTokens?: number;
  threadId?: string;
  /**
   * If true, spawn claude-code with `--permission-mode plan`. Claude will
   * produce a plan then call ExitPlanMode; the UI gates execution behind a
   * user approval ("Proceed.") sent as a follow-up message.
   */
  planMode?: boolean;
  /**
   * Reasoning effort for models that support it (codex/o-series, future
   * Anthropic extended-thinking). Values: "none" | "minimal" | "low" |
   * "medium" | "high" | "xhigh". Passed through provider-specific.
   */
  reasoningEffort?: string;
  jeromeMode?: boolean;
  /**
   * Working directory the CLI process should spawn into. When set, this
   * overrides SPECTRE_REPO_PATH so workspace chats can operate inside the
   * slot's clone (`<workspaces>/<slot>/repo`) instead of the
   * default repo. Falls back through opts.cwd → SPECTRE_REPO_PATH
   * → process.cwd() in each provider.
   */
  cwd?: string;
  /**
   * Restrict the broker tools EXPOSED to the model to this allowlist of MCP
   * tool names (dot form, e.g. "memory.search"). Used by the bounded proactive
   * run to structurally limit autonomy to a safe, read-mostly surface — a tool
   * not in the list is never offered, so the model cannot call it. Provider-
   * agnostic analogue of the CLI's `--allowed-tools`. Honoured by the litellm
   * provider; ignored by providers without an MCP broker.
   */
  toolAllowlist?: string[];
  /**
   * Bounded autonomous background run (no human at the console). Tells the MCP
   * broker to enforce the pre-seeded read-mostly quota policies via the
   * permission gate (SPECTRE_AUTONOMOUS / SPECTRE_AUTONOMOUS_THREAD) instead of
   * prompting a human who will never answer. Interactive chat never sets this.
   */
  autonomous?: boolean;
  /**
   * Headless self-evolution (workshop) run on the provider-agnostic brain. Tells
   * the broker (SPECTRE_WORKSHOP) to AUTO-APPROVE the code tools (bash/write/edit)
   * — the workshop is branch-isolated and the diff is human-reviewed before push,
   * the same trust model as the CLI's `--permission-mode bypassPermissions`. Pair
   * with `cwd` (the target repo) so the code tools operate inside that clone, and
   * a `toolAllowlist` of the code tools. Interactive chat never sets this.
   */
  workshopMode?: boolean;
}

export type Streamer = (opts: StreamOptions) => AsyncGenerator<StreamChunk>;

export const PROVIDER_ENV_KEYS: Record<Provider, string | null> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENAI_API_KEY",
  // The provider-agnostic standard brain — on when its base URL is configured.
  litellm: "SPECTRE_LITELLM_URL",
  "claude-code": null,
  "gemini-cli": null,
  "codex-cli": null,
  ollama: null,
  "spectre-mode": null,
  // Gated by SPECTRE_ALLOW_CLI_BACKENDS + an enabled cli-command brain (not a single env key).
  "cli-text": null,
};
