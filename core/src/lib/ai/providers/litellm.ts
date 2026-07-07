/**
 * Provider-agnostic agentic brain — the production-ready default.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The original brain ran by spawning the `claude` CLI on a personal Claude
 * subscription (see claude-code.ts). That adapter is off by default and requires
 * the SPECTRE_ALLOW_CLAUDE_CLI opt-in gate. This provider replaces it with a
 * bring-your-own-credentials path: ONE OpenAI-compatible function-calling loop
 * pointed at a configurable base URL.
 *
 *   model  ◀──OpenAI /chat/completions──▶  SPECTRE_LITELLM_URL
 *     │                                     (LiteLLM proxy, Ollama /v1, OpenAI,
 *     │                                      vLLM, Azure, Bedrock — anything that
 *     │                                      speaks the OpenAI API)
 *     ▼
 *   tool_calls ──▶ spectre MCP broker (stdio) ──▶ Spectre's governance
 *                  (approval gate, quotas, CORE_TOKEN-scoped core calls)
 *
 * The KEY design choice: tools are executed through the SAME spectre-mcp-broker
 * the CLI used. We connect to it as an MCP *client*, list its tools, expose them
 * as native OpenAI function schemas, and call them back through the broker — so
 * every permission prompt, quota, and audit row is reused untouched. Because the
 * model only ever sees OUR tools (never a CLI's builtin Bash/Edit/Write), there
 * are no foreign-builtin conflicts to block — the whole CONFLICTING_BUILTINS
 * problem from the CLI adapter simply does not exist here.
 *
 * CONFIG (.env.local)
 *   SPECTRE_LITELLM_URL    base URL incl. /v1 (e.g. http://127.0.0.1:4000/v1 for
 *                          a LiteLLM proxy, or http://127.0.0.1:11434/v1 for a
 *                          direct Ollama). Presence of this var = provider on.
 *   SPECTRE_LITELLM_KEY    API key / LiteLLM master key (any value for Ollama).
 *   SPECTRE_LITELLM_MODEL  default model id to request (e.g. qwen2.5:7b-instruct
 *                          or a LiteLLM alias). Per-turn model.cliModel overrides.
 */

import OpenAI from "openai";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamChunk, StreamOptions } from "./types";
import { registerAbort } from "../abort";
import { loadMcpServers } from "@/lib/ext/dirs";
import { reportEvent } from "@/lib/monitor/report";
import { estimateTokens } from "@/lib/ai/tokens";

// Per-run hard token cap (cumulative input+output across all tool iterations).
// A runaway agentic loop on the operator's metered key is the scariest spend
// risk; this aborts it. Generous default so real turns aren't cut; 0 = disabled.
const RUN_TOKEN_CAP = Number(process.env.SPECTRE_RUN_TOKEN_CAP || 2_000_000);

// The MCP client SDK is loaded lazily (dynamic import) inside connectBroker so it
// never touches the core's module-load path — a chatless boot stays clean and a
// bundler quirk in the (bleeding-edge) Next build can't take the whole core down.

type ChatParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

// Hard ceiling on the model↔tools loop so a model that keeps tool-calling can
// never run forever. ~20 round-trips is far more than any real chat turn needs.
const MAX_TOOL_ITERATIONS = 20;
// MCP requests (esp. tool calls that block on a human approval modal) can take
// far longer than the SDK's 60s default. Give them a generous window.
const MCP_CALL_TIMEOUT_MS = 30 * 60 * 1000;

// Cap a single tool result so one huge output (a big file dump, long logs) can't
// blow the context window on its own. The model still sees a useful head.
const MAX_TOOL_RESULT_CHARS = Number(process.env.SPECTRE_MAX_TOOL_RESULT_CHARS || 16000);

/** OpenAI text content part + the Anthropic cache hint LiteLLM forwards. */
interface CachedTextPart {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** Estimate a chat message's tokens (content + tool-call args + per-message overhead). */
function msgTokens(m: ChatParam): number {
  let n = estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
  const tc = (m as { tool_calls?: Array<{ function?: { arguments?: string } }> }).tool_calls;
  if (Array.isArray(tc)) for (const c of tc) n += estimateTokens(c.function?.arguments ?? "");
  return n + 4;
}

/**
 * Trim messages to a token budget: always keep the system message (index 0) + the
 * NEWEST messages that fit, dropping the oldest. Keeps at least the latest turn
 * even if it alone exceeds budget (the model surfaces that rather than us 400ing
 * blindly). Trims in WHOLE groups: an assistant message with tool_calls is always
 * kept or dropped together with ALL of its following role:'tool' result messages,
 * so we never emit an orphan tool message without its preceding assistant tool_use
 * or an assistant tool_use without all its results.
 */
export function fitMessages(messages: ChatParam[], budgetTokens: number): ChatParam[] {
  if (messages.length <= 1) return messages;
  const system = messages[0];
  const rest = messages.slice(1);

  // Build groups: each group is either a lone non-tool-call message, or an
  // assistant-with-tool_calls message bundled with all its following tool results.
  type Group = ChatParam[];
  const groups: Group[] = [];
  let i = 0;
  while (i < rest.length) {
    const msg = rest[i];
    const tc = (msg as { tool_calls?: unknown[] }).tool_calls;
    if (msg.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
      // Collect this assistant message + all immediately following tool results.
      const group: ChatParam[] = [msg];
      let j = i + 1;
      while (j < rest.length && rest[j].role === "tool") {
        group.push(rest[j]);
        j++;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([msg]);
      i++;
    }
  }

  // Greedily keep the newest groups that fit within the budget.
  let total = msgTokens(system);
  const keptGroups: Group[] = [];
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const groupCost = groups[gi].reduce((s, m) => s + msgTokens(m), 0);
    if (keptGroups.length > 0 && total + groupCost > budgetTokens) break;
    total += groupCost;
    keptGroups.unshift(groups[gi]);
  }

  // Flatten and strip any leading orphan tool messages (belt-and-suspenders).
  const kept = keptGroups.flat();
  while (kept.length && kept[0].role === "tool") kept.shift();
  return [system, ...kept];
}

export function isLiteLLMConfigured(): boolean {
  return !!process.env.SPECTRE_LITELLM_URL;
}

/**
 * Read the `orchestrate` flag from app_config.
 * Returns true when the stored value is exactly "1".
 * Falls back to false on any error (fail safe: don't add unexpected tools).
 */
async function isOrchestrationEnabled(): Promise<boolean> {
  try {
    const { createServiceSupabase } = await import("@/lib/supabase/server");
    const supabase = createServiceSupabase();
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "orchestrate")
      .maybeSingle();
    return data?.value === "1";
  } catch {
    return false;
  }
}

/**
 * Auto-detect the models the configured gateway exposes (OpenAI GET /v1/models).
 * This is how a model added to the LiteLLM proxy — statically in
 * litellm-config.yaml or at runtime via the admin API — shows up in Spectre's
 * model picker with no code change. Returns [] on any failure (no gateway, etc.).
 */
export async function listLiteLLMModels(): Promise<string[]> {
  if (!isLiteLLMConfigured()) return [];
  try {
    const res = await client().models.list();
    const ids = (res.data ?? []).map((m) => m.id).filter(Boolean);
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

// bun's fetch enforces a hard ~300s client timeout that an AbortSignal cannot
// extend. A slow CPU backend's time-to-first-token (prompt eval on a big
// tool-laden prompt) OR a long generation can exceed that, so we hand the OpenAI
// SDK a fetch that sets bun's `timeout: false` to disable the ceiling. The SDK's
// own `timeout` (below) remains the real bound via its AbortController. The extra
// `timeout` field is ignored by node/undici fetch, so this stays cross-runtime.
const noCeilingFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  fetch(input, { ...init, timeout: false } as RequestInit)) as typeof fetch;

function client(): OpenAI {
  return new OpenAI({
    baseURL: process.env.SPECTRE_LITELLM_URL,
    apiKey: process.env.SPECTRE_LITELLM_KEY || "sk-spectre-local",
    fetch: noCeilingFetch,
    // Agentic turns can be long, and self-hosted backends (esp. Ollama, which
    // buffers the whole response when tools are present) are slow to first byte.
    // Be patient (default 20 min); keep it <= the chat-runner's
    // SPECTRE_TURN_TIMEOUT_MS so the gateway call bounds first.
    timeout: Number(process.env.SPECTRE_LITELLM_TIMEOUT_MS || 20 * 60 * 1000),
    // Retries fire ONLY on connection errors + 408/409/429/5xx REJECTIONS (with
    // exponential backoff) — never on a slow-but-streaming 200, so this can't
    // double the load on a slow CPU backend. Without it a single transient 429
    // or gateway 5xx drops the whole turn. Overloaded-box self-hosters can set
    // SPECTRE_LITELLM_MAX_RETRIES=0 to opt out.
    maxRetries: Number(process.env.SPECTRE_LITELLM_MAX_RETRIES ?? 2),
  });
}

/** OpenAI function names allow [a-zA-Z0-9_-]{1,64}; MCP names use dots. */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Which connected MCP client owns a tool, and its original (un-sanitized) name. */
interface ToolOwner {
  client: Client;
  original: string;
}

interface BrokerHandle {
  /** every connected MCP client (the built-in broker + any external servers). */
  clients: Client[];
  tools: ChatTool[];
  /** sanitized OpenAI function name → owning client + original MCP tool name */
  owners: Map<string, ToolOwner>;
  close: () => void;
}

/**
 * A minimal, SAFE env for an EXTERNAL (user-registered) MCP server. We do NOT
 * hand a third-party process the core's full env — that holds CORE_TOKEN,
 * Supabase service keys, etc. Only PATH-ish basics + the server's own declared
 * env are passed through.
 */
function externalServerEnv(declared: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "USERPROFILE", "APPDATA"]) {
    const v = process.env[k];
    if (typeof v === "string") base[k] = v;
  }
  return { ...base, ...declared };
}

/**
 * Default-deny env allowlist for the broker child. The broker (and every tool it
 * spawns) gets ONLY the vars it actually reads — verified against every
 * `process.env.*` in spectre-mcp-broker/*.mjs — so the core's secrets it never
 * needs (Supabase service key, provider API keys, LiteLLM key, SESSION_SECRET,
 * PIN_HASH, …) are NOT copied into the broker process or any subprocess.
 */
const BROKER_ENV_ALLOW = [
  // base shell/runtime needed to spawn + run
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec", "windir", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  // broker config (set explicitly below or read by the broker's tools)
  "CORE_TOKEN", "SPECTRE_SERVICE_TOKEN", "SPECTRE_APP_URL", "SPECTRE_THREAD_ID",
  "SPECTRE_AUTONOMOUS", "SPECTRE_AUTONOMOUS_THREAD", "SPECTRE_WORKSHOP", "SPECTRE_ENABLE_DISPATCH_TOOL",
  "SPECTRE_DATA_DIR", "SPECTRE_REPO_PATH", "SPECTRE_FILES_ROOT", "SPECTRE_GENERATED_DIR", "SPECTRE_STANDALONE_GENERATED_DIR",
  "SPECTRE_SHELL_URL", "SPECTRE_SHOTTER_URL", "SPECTRE_SHOTTER_COOKIE",
  "SPECTRE_ALLOW_GEMINI_CLI", "SPECTRE_ALLOW_CODEX_CLI", "SPECTRE_ALLOW_CLI_BACKENDS", "GEMINI_CLI_BIN", "CODEX_CLI_BIN", "CODEX_HOME",
  "SPECTRE_MCP_BROKER", "SPECTRE_MCP_BROKER_BIN", "SPECTRE_MCP_BROKER_PATH", "OLLAMA_HOST",
  // data tools may interpolate {env.X}, but only X in SPECTRE_TOOL_ENV_ALLOW (the
  // broker re-checks this); the allowlist itself must reach the broker to be read.
  "SPECTRE_TOOL_ENV_ALLOW",
];

/**
 * Spawn + connect the spectre MCP broker exactly as claude-code.ts does (same
 * env contract, same back-channel to the core for approvals), list its tools as
 * OpenAI function schemas, THEN connect any operator-registered external MCP
 * servers (data dir `mcp/servers.json`) and aggregate their tools too. Each tool
 * records which client owns it so the loop dispatches the call correctly.
 * Degrades to a tool-less chat if nothing connects — a hiccup must not kill the
 * conversation.
 */
async function connectBroker(opts: StreamOptions): Promise<BrokerHandle> {
  const noop: BrokerHandle = { clients: [], tools: [], owners: new Map(), close: () => {} };

  // No thread → no broker session (the broker exits without SPECTRE_THREAD_ID).
  // Tools also disabled if explicitly turned off.
  if (!opts.threadId || process.env.SPECTRE_MCP_BROKER === "0") return noop;

  // Two ways to launch the broker:
  //  - SPECTRE_MCP_BROKER_BIN: a bun-compiled broker BINARY (the deploy path —
  //    required when the core itself is a compiled binary, because then
  //    process.execPath is the core binary, not a JS runtime).
  //  - else process.execPath + the broker .mjs (dev: core run under node/bun).
  const brokerBin = process.env.SPECTRE_MCP_BROKER_BIN;
  const brokerPath =
    process.env.SPECTRE_MCP_BROKER_PATH ||
    join(process.cwd(), "spectre-mcp-broker/index.mjs");

  // Mirror claude-code.ts brokerEnv so the broker authenticates back to the core
  // identically (CORE_TOKEN gate, permission endpoint, service token).
  const childEnv: Record<string, string> = {};
  // Default-deny: copy only allowlisted vars (NOT the core's full env/secrets).
  for (const k of BROKER_ENV_ALLOW) {
    const val = process.env[k];
    if (typeof val === "string") childEnv[k] = val;
  }
  // Plus any operator-declared keys data tools may use via {env.X} — and nothing
  // else (the broker re-restricts {env.X} to this same allowlist).
  for (const k of (process.env.SPECTRE_TOOL_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const val = process.env[k];
    if (typeof val === "string") childEnv[k] = val;
  }
  childEnv.SPECTRE_THREAD_ID = opts.threadId;
  childEnv.SPECTRE_APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:8787";
  childEnv.SPECTRE_SERVICE_TOKEN = process.env.SPECTRE_SERVICE_TOKEN || "";
  childEnv.CORE_TOKEN = process.env.CORE_TOKEN || "";
  // Bounded autonomous run: make the broker enforce the pre-seeded quota policies
  // through the permission gate (it would otherwise prompt a human). Mirrors
  // claude-code.ts's autonomous env contract.
  if (opts.autonomous) {
    childEnv.SPECTRE_AUTONOMOUS = "1";
    childEnv.SPECTRE_AUTONOMOUS_THREAD = opts.threadId;
  }
  // Headless workshop run: auto-approve the code tools (branch-isolated, reviewed
  // before push). Combined with `cwd` below, the broker's bash/write/edit operate
  // inside the target repo clone.
  if (opts.workshopMode) childEnv.SPECTRE_WORKSHOP = "1";

  // Configurable orchestration for non-Jerome brains: when `orchestrate` is "1"
  // in app_config, expose dispatch_to_model on the regular broker so any brain
  // (Ollama, LiteLLM, etc.) can fan out to CLI specialists. Skipped for jeromeMode
  // — that path already sets SPECTRE_ENABLE_DISPATCH_TOOL via claude-code.ts.
  if (!opts.jeromeMode && (await isOrchestrationEnabled())) {
    childEnv.SPECTRE_ENABLE_DISPATCH_TOOL = "1";
  }

  // Structural tool allowlist (dot names) — a tool not listed is never exposed.
  const allow = opts.toolAllowlist ? new Set(opts.toolAllowlist) : null;

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  // cwd: where the broker's bash/write/edit operate. For a workshop run this is
  // the target repo clone (opts.cwd); for chat it's the broker's default.
  const spawnCwd = opts.cwd || undefined;

  const clients: Client[] = [];
  const tools: ChatTool[] = [];
  const owners = new Map<string, ToolOwner>();

  type ListedTools = { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };

  // Register a connected client's tools into the aggregate. First writer wins on
  // a sanitized-name collision, so the built-in broker (added first) always beats
  // an external server exposing the same name.
  const addClientTools = (
    client: Client,
    listed: ListedTools,
    o: { allowSet?: Set<string> | null; prefix?: string },
  ) => {
    for (const t of listed.tools) {
      const original = t.name;
      if (o.allowSet && !o.allowSet.has(original)) continue;
      // `tools.list` is a discovery helper for the CLI's prose tool block; the
      // function-calling loop gets every tool natively, so it's just noise here.
      if (original === "tools.list") continue;
      const fnName = sanitizeToolName(o.prefix ? `${o.prefix}${original}` : original);
      if (owners.has(fnName)) continue; // built-in wins over an external duplicate
      owners.set(fnName, { client, original });
      tools.push({
        type: "function",
        function: {
          name: fnName,
          description: t.description || original,
          parameters: (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
        },
      });
    }
  };

  // 1. The built-in spectre broker (the core's tools, with the approval gate).
  //    allow mirrors the claude-code restriction (a focused thread sees
  //    only its tools).
  try {
    const transport = new StdioClientTransport(
      brokerBin
        ? { command: brokerBin, args: [], env: childEnv, stderr: "ignore", cwd: spawnCwd }
        : { command: process.execPath, args: [brokerPath], env: childEnv, stderr: "ignore", cwd: spawnCwd },
    );
    const mcp = new Client({ name: "spectre-core", version: "0.1.0" }, { capabilities: {} });
    await mcp.connect(transport);
    clients.push(mcp);
    addClientTools(mcp, (await mcp.listTools()) as ListedTools, {
      allowSet: allow,
    });
  } catch {
    /* broker unreachable → degrade; external servers may still connect below */
  }

  // 2. Operator-registered EXTERNAL MCP servers (data dir mcp/servers.json).
  //    Only in normal chat — bounded/focused runs (allowlist, autonomous,
  //    workshop) deliberately stay on the built-in toolset. External servers get
  //    a CLEAN env (never the core's secrets) and name-spaced tool names.
  const externalAllowed =
    !opts.toolAllowlist && !opts.autonomous && !opts.workshopMode;
  if (externalAllowed) {
    let servers: ReturnType<typeof loadMcpServers> = [];
    try {
      servers = loadMcpServers();
    } catch {
      servers = [];
    }
    for (const s of servers) {
      try {
        let transport;
        if (s.url) {
          const { SSEClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/sse.js"
          );
          transport = new SSEClientTransport(new URL(s.url));
        } else if (s.command) {
          transport = new StdioClientTransport({
            command: s.command,
            args: s.args ?? [],
            env: externalServerEnv(s.env ?? {}),
            stderr: "ignore",
          });
        } else {
          continue;
        }
        const c = new Client({ name: "spectre-core", version: "0.1.0" }, { capabilities: {} });
        await c.connect(transport);
        clients.push(c);
        addClientTools(c, (await c.listTools()) as ListedTools, {
          prefix: `${sanitizeToolName(s.name)}__`,
        });
      } catch {
        /* skip a server that won't connect — never break the chat */
      }
    }
  }

  if (clients.length === 0) return noop;
  return {
    clients,
    tools,
    owners,
    close: () => {
      for (const c of clients) void c.close().catch(() => {});
    },
  };
}

interface AccumulatedCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Scan text for balanced top-level `{...}` object substrings (string-aware), so we
 * can recover a tool call a weak model emitted as TEXT instead of via the structured
 * tool_calls channel.
 */
function* jsonObjectCandidates(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0 && --depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/**
 * Recover a tool call a model wrote as TEXT (a JSON blob in its reply) rather than
 * emitting it via the structured tool_calls channel — common for small local models
 * handed a large tool surface. Matches the usual shapes:
 *   {"type":"function","function":{"name","parameters"|"arguments"}}
 *   {"name","arguments"|"parameters"}   |   {"tool_calls":[…]}
 * Only returns a call whose name is a REAL available tool (exact match), so an
 * incidental JSON example isn't executed. Returns the first match, or null.
 */
function extractTextToolCall(text: string, valid: Set<string>): { name: string; args: string } | null {
  if (!valid.size) return null;
  for (const cand of jsonObjectCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const shapes: Record<string, unknown>[] = [];
    if (Array.isArray(obj.tool_calls)) {
      for (const t of obj.tool_calls) {
        if (t && typeof t === "object") {
          const tt = t as Record<string, unknown>;
          shapes.push((tt.function ?? tt) as Record<string, unknown>);
        }
      }
    }
    if (obj.function && typeof obj.function === "object") shapes.push(obj.function as Record<string, unknown>);
    shapes.push(obj);
    for (const fn of shapes) {
      const name = fn?.name;
      if (typeof name === "string" && valid.has(name)) {
        const raw = (fn.arguments ?? fn.parameters ?? {}) as unknown;
        const args = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
        return { name, args };
      }
    }
  }
  return null;
}

/** Flatten an MCP tool result's content array into a plain string for the model. */
function renderToolResult(res: {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): string {
  const text = (res.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
  if (text) return text;
  if (res.structuredContent !== undefined) {
    try {
      return JSON.stringify(res.structuredContent);
    } catch {
      /* fall through */
    }
  }
  return res.isError ? "(tool error, no detail)" : "(no output)";
}

export async function* streamLiteLLM(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  if (!isLiteLLMConfigured()) {
    throw new Error(
      "litellm provider not configured: set SPECTRE_LITELLM_URL (OpenAI-compatible base URL).",
    );
  }

  const openai = client();
  // Per-turn selection wins: a synthesized/hinted model (model.cliModel) beats
  // the env default, so picking a LiteLLM-detected model in Settings takes effect.
  const modelName =
    opts.model.cliModel || process.env.SPECTRE_LITELLM_MODEL || opts.model.id;
  const broker = await connectBroker(opts);

  const controller = new AbortController();
  const unregister = opts.threadId
    ? registerAbort(opts.threadId, () => {
        controller.abort();
        broker.close();
      })
    : () => { /* no threadId — nothing to unregister from the abort registry */ };

  // Anthropic prompt caching (LiteLLM passes cache_control through): mark the
  // stable system prefix (soul + skills index) with a cache breakpoint so
  // consecutive turns reuse it. Claude/Anthropic models only — every other
  // backend gets the plain string. SPECTRE_PROMPT_CACHE=0 opts out.
  const wantCache =
    process.env.SPECTRE_PROMPT_CACHE !== "0" && /claude|anthropic/i.test(modelName);
  const cacheBreak =
    wantCache && opts.cacheBreak && opts.cacheBreak > 0 && opts.cacheBreak <= opts.system.length
      ? opts.cacheBreak
      : 0;
  let systemMessage: ChatParam = { role: "system", content: opts.system };
  if (cacheBreak) {
    const parts: CachedTextPart[] = [
      { type: "text", text: opts.system.slice(0, cacheBreak), cache_control: { type: "ephemeral" } },
    ];
    const tail = opts.system.slice(cacheBreak);
    if (tail) parts.push({ type: "text", text: tail });
    systemMessage = { role: "system", content: parts } as ChatParam;
  }
  const messages: ChatParam[] = [
    systemMessage,
    ...opts.messages.map(
      (m): ChatParam => ({ role: m.role, content: m.content }),
    ),
  ];

  let promptTokens = 0;
  let completionTokens = 0;
  let cumInput = 0; // cumulative billed tokens across iterations (for the run cap)
  let cumOutput = 0;

  // Context budget: keep system + history + accumulated tool turns under the
  // model's window so a long/tool-heavy turn can't silently overflow + 400.
  // SPECTRE_CONTEXT_TOKENS lets a self-hoster set their LOCAL model's real window
  // (the ModelDef default can be wrong for a small local model).
  const ctxWindow = Number(process.env.SPECTRE_CONTEXT_TOKENS) || opts.model.contextWindow || 128_000;
  const msgBudget = Math.max(2000, ctxWindow - (opts.model.maxOutputTokens || 4096) - 2000);

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const stream = await openai.chat.completions.create(
        {
          model: modelName,
          messages: fitMessages(messages, msgBudget),
          ...(broker.tools.length > 0
            ? { tools: broker.tools, tool_choice: "auto" as const }
            : {}),
          max_tokens: opts.model.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: controller.signal },
      );

      let assistantText = "";
      const calls: AccumulatedCall[] = [];
      let iterIn = 0;
      let iterOut = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          yield { type: "token", text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!calls[idx]) calls[idx] = { id: "", name: "", args: "" };
            if (tc.id) calls[idx].id = tc.id;
            if (tc.function?.name) calls[idx].name += tc.function.name;
            if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
          }
        }
        if (chunk.usage) {
          iterIn = chunk.usage.prompt_tokens ?? iterIn;
          iterOut = chunk.usage.completion_tokens ?? iterOut;
        }
      }
      // This iteration's usage: keep last-iter for the done event + accumulate
      // cumulative (each iteration re-sends the context, so summing = real spend).
      // Ollama's OpenAI-compatible endpoint often omits `usage` on tool-call turns,
      // leaving iterIn + iterOut = 0. Fall back to a character-based estimate so
      // RUN_TOKEN_CAP still trips on the local path.
      if (iterIn + iterOut === 0) {
        // Input: estimate over the messages sent this iteration.
        const sentMessages = fitMessages(messages, msgBudget);
        for (const m of sentMessages) iterIn += msgTokens(m);
        // Output: assistant text + accumulated tool-call arguments.
        iterOut += estimateTokens(assistantText);
        for (const c of calls) if (c) iterOut += estimateTokens(c.args);
      }
      promptTokens = iterIn;
      completionTokens = iterOut;
      cumInput += iterIn;
      cumOutput += iterOut;

      // Per-run token cap: abort a runaway loop before it burns the metered key.
      if (RUN_TOKEN_CAP > 0 && cumInput + cumOutput > RUN_TOKEN_CAP) {
        console.error(`[litellm] run token cap ${RUN_TOKEN_CAP} exceeded (${cumInput + cumOutput}) — stopping`);
        void reportEvent({
          severity: "critical",
          component: "provider:litellm",
          description: `Run stopped: per-run token cap ${RUN_TOKEN_CAP} exceeded (${cumInput + cumOutput} tokens)${opts.threadId ? ` on thread ${opts.threadId}` : ""}.`,
          push: true,
        });
        yield {
          type: "token",
          text: `\n\n⚠️ Stopped: this run hit the token cap (${RUN_TOKEN_CAP.toLocaleString()}). Raise SPECTRE_RUN_TOKEN_CAP if this was intended.`,
        };
        yield { type: "done", model: modelName, inputTokens: cumInput, outputTokens: cumOutput };
        return;
      }

      let toolCalls = calls.filter((c) => c && c.name);

      // Fallback for weak local models that EMIT a tool call as TEXT (a JSON blob in
      // content) instead of using the structured tool_calls channel — recover it so
      // the tool actually runs and renders as a tool chip, instead of the raw JSON
      // leaking as the final answer. Only fires when the name is a real tool.
      if (toolCalls.length === 0 && assistantText) {
        const validNames = new Set(
          broker.tools
            .map((t) => (t as { function?: { name?: string } }).function?.name)
            .filter((n): n is string => typeof n === "string"),
        );
        const recovered = extractTextToolCall(assistantText, validNames);
        if (recovered) {
          console.log(`[litellm] recovered text-emitted tool call: ${recovered.name}`);
          toolCalls = [{ id: `call_text_${iter}`, name: recovered.name, args: recovered.args }];
        }
      }

      // No tool calls → the model produced its final answer. Done.
      if (toolCalls.length === 0) {
        yield {
          type: "done",
          model: modelName,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        };
        return;
      }

      // Record the assistant's tool-call turn so the model sees its own request
      // alongside the results on the next iteration.
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls.map((c, i) => ({
          id: c.id || `call_${iter}_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });

      for (let i = 0; i < toolCalls.length; i++) {
        const c = toolCalls[i];
        const callId = c.id || `call_${iter}_${i}`;
        const owner = broker.owners.get(c.name);
        const original = owner?.original ?? c.name;
        let args: Record<string, unknown> = {};
        try {
          args = c.args ? JSON.parse(c.args) : {};
        } catch {
          args = {};
        }

        yield { type: "tool_use", id: callId, name: original, input: args };

        let output = "";
        let isError = false;
        if (!owner) {
          output = `Tool "${original}" is unavailable (not connected).`;
          isError = true;
        } else {
          try {
            const res = (await owner.client.callTool(
              { name: owner.original, arguments: args },
              undefined,
              { signal: controller.signal, timeout: MCP_CALL_TIMEOUT_MS },
            )) as unknown as Parameters<typeof renderToolResult>[0];
            isError = !!res.isError;
            output = renderToolResult(res);
          } catch (err) {
            isError = true;
            output = `Tool "${original}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
        }

        if (output.length > MAX_TOOL_RESULT_CHARS) {
          output =
            output.slice(0, MAX_TOOL_RESULT_CHARS) +
            `\n…[truncated ${output.length - MAX_TOOL_RESULT_CHARS} chars]`;
        }
        yield { type: "tool_result", toolUseId: callId, output, isError };
        messages.push({ role: "tool", tool_call_id: callId, content: output });
      }
      // loop: feed the tool results back to the model for its next step
    }

    // Hit the iteration ceiling without a final answer — grant one tool-less
    // GRACE TURN so the model summarizes where it got to instead of going
    // silent mid-task. No `tools` param → it cannot request more calls.
    try {
      messages.push({
        role: "system",
        content:
          `Tool budget exhausted (${MAX_TOOL_ITERATIONS} rounds). Do NOT request more tools — ` +
          `summarize what you accomplished, what remains, and how to continue.`,
      });
      const grace = await openai.chat.completions.create(
        {
          model: modelName,
          messages: fitMessages(messages, msgBudget),
          max_tokens: opts.model.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: controller.signal },
      );
      for await (const chunk of grace) {
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield { type: "token", text };
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          cumInput += chunk.usage.prompt_tokens ?? 0;
          cumOutput += chunk.usage.completion_tokens ?? 0;
        }
      }
    } catch (err) {
      console.error(`[litellm] grace turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    yield {
      type: "done",
      model: modelName,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
    };
  } finally {
    unregister();
    broker.close();
  }
}

export async function quickCompleteLiteLLM(prompt: string): Promise<string> {
  const openai = client();
  let modelName =
    process.env.SPECTRE_LITELLM_MODEL ||
    (await listLiteLLMModels().then((ms) => ms[0] ?? "")) ||
    "gpt-4o-mini";
  const res = await openai.chat.completions.create({
    model: modelName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
  });
  return res.choices?.[0]?.message?.content?.trim() ?? "";
}
