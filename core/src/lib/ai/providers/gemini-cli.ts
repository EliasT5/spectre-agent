import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ChatMessage, StreamChunk, StreamOptions } from "./types";
import { killProcessTree } from "./process-group";
import { renderMcpToolBlock } from "../mcp-catalog";
import { cliAllowed } from "../cli-gate";

const GEMINI_CLI_BIN = process.env.GEMINI_CLI_BIN || "gemini";
const POLICY_DIR = join(homedir(), ".jerome", "gemini-policies");
const APPROVAL_MODE = process.env.GEMINI_APPROVAL_MODE || "auto_edit";
const GEMINI_TIMEOUT_MS = Number.parseInt(
  process.env.GEMINI_TIMEOUT_MS || "120000",
  10
);

/**
 * Why no UUID-based --resume:
 * The CLI's --resume takes "latest" or a numeric session index, not a
 * UUID — so the first iteration of this provider (which captured the
 * `session_id` from the `init` event and passed it back) silently
 * failed to resume on every call after the first. Multi-thread cases
 * also can't safely use "latest" because thread interleaving means
 * "the latest gemini session for this workspace" might belong to a
 * different conversation. The honest answer is: we don't try to
 * resume gemini's internal session at all. Instead we serialize the
 * Jerome thread's full history into the prompt on every turn.
 *
 * Tradeoff: gemini doesn't see its own previous tool-use state across
 * turns. Acceptable for chat; would need rework if we ever want
 * gemini-cli to drive multi-turn agentic flows like the workshop.
 */

function savePolicy(threadId: string, systemPrompt: string): string {
  mkdirSync(POLICY_DIR, { recursive: true });
  // The threadId may be undefined for one-off calls — caller passes a
  // stable label like "temp-one-off" in that case.
  const path = join(POLICY_DIR, `${threadId}.md`);
  writeFileSync(path, systemPrompt);
  return path;
}

/**
 * Render a Jerome message list into a single prompt string. The system
 * prompt (Jerome's soul + skills) goes via --policy; conversation
 * history is appended as `User: …` / `Assistant: …` blocks; the most
 * recent user message becomes the active turn.
 */
function buildPromptFromHistory(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  const lastIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();
  if (lastIdx < 0) return "";

  const history = messages.slice(0, lastIdx);
  const current = messages[lastIdx];

  if (history.length === 0) return current.content;

  const transcript = history
    .map((m) => {
      const tag =
        m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
      return `${tag}: ${m.content}`;
    })
    .join("\n\n");
  return (
    `[Conversation so far — for context only, the active turn is at the bottom]\n\n` +
    transcript +
    `\n\n[Active turn — respond to this]\n\nUser: ${current.content}`
  );
}

export interface SpawnGeminiOptions {
  threadId?: string;
  systemPrompt?: string;
  cwd?: string;
  approvalMode?: string;
  cliModel?: string;
  prompt: string;
}

const liveProcesses = new Map<string, ChildProcess>();

export function abortGeminiForThread(threadId: string): boolean {
  const proc = liveProcesses.get(threadId);
  if (!proc) return false;
  killProcessTree(proc);
  liveProcesses.delete(threadId);
  return true;
}

export function spawnGeminiCli(opts: SpawnGeminiOptions): ChildProcess {
  const args = [
    // --skip-trust: the agent runs from a repo cwd which gemini hasn't
    // been told to trust interactively; the CLI refuses headless work
    // in untrusted dirs without this flag (or with
    // GEMINI_CLI_TRUST_WORKSPACE=true in env, which we also set).
    "--skip-trust",
    "-o",
    "stream-json",
    "--approval-mode",
    opts.approvalMode || APPROVAL_MODE,
  ];

  // -m forces a specific model. For "auto-gemini-3" we omit -m because
  // that's gemini's own default (verified via init event in
  // stream-json output) — passing it explicitly may be redundant but
  // is harmless.
  if (opts.cliModel) {
    args.push("-m", opts.cliModel);
  }

  // System prompt goes via --policy <file>. Real flag (verified
  // against `gemini --help`): "Additional policy files or directories
  // to load". Each thread gets its own policy file so concurrent
  // threads don't stomp each other's soul.
  if (opts.systemPrompt) {
    const policyPath = savePolicy(opts.threadId ?? "temp-one-off", opts.systemPrompt);
    args.push("--policy", policyPath);
  }

  // MCP — load the Jerome broker registered in the repo's .gemini/settings.json
  // (project scope). Only enable when we have a threadId, since the broker
  // requires SPECTRE_THREAD_ID and one-off quick completes don't have one.
  if (opts.threadId) {
    args.push("--allowed-mcp-server-names", "jerome");
  }

  // The prompt now carries the full conversation history (see
  // buildPromptFromHistory in streamGeminiCli) so we don't try to
  // resume gemini's internal session.
  args.push("-p", opts.prompt);

  // Spawn env carries the per-session broker secrets. Gemini inherits
  // them and forwards to the broker subprocess when it spawns the MCP
  // server, so SPECTRE_THREAD_ID (which the broker requires at startup)
  // lands in the right place.
  const spawnEnv = {
    ...process.env,
    ...(opts.threadId
      ? {
          SPECTRE_THREAD_ID: opts.threadId,
          SPECTRE_APP_URL:
            process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000",
          SPECTRE_SERVICE_TOKEN: process.env.SPECTRE_SERVICE_TOKEN || "",
        }
      : {}),
  };

  return spawn(GEMINI_CLI_BIN, args, {
    cwd: opts.cwd || process.env.SPECTRE_REPO_PATH || process.cwd(),
    env: spawnEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so the Stop button can kill gemini and any
    // descendants in one go.
    detached: true,
  });
}

interface GeminiStreamEvent {
  type: string;
  session_id?: string;
  /** Present on `init`. Real upstream model id, e.g. "auto-gemini-3". */
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  // Tool use/result events emitted by gemini-cli in stream-json
  tool_name?: string;
  parameters?: unknown; // actual field name in stream-json (not tool_input)
  tool_id?: string;
}

export async function* streamGeminiCli(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  // Defence-in-depth opt-in gate at the spawn boundary: never spawn the
  // CLI even if a caller reached here without a gate check (mirrors spawnClaudeCode).
  if (!cliAllowed("gemini-cli")) {
    throw new Error(
      "Gemini CLI is disabled. Set SPECTRE_ALLOW_GEMINI_CLI=1 to enable it (uses your own Google login), " +
        "or use the provider-agnostic LiteLLM brain instead.",
    );
  }
  const prompt = buildPromptFromHistory(opts.messages);
  if (!prompt) {
    throw new Error("streamGeminiCli: no user message in conversation");
  }

  // Queue + waiter pattern (mirrors claude-code.ts). Declared BEFORE
  // the spawn so the data handler's closure captures real bindings,
  // not TDZ-zone references.
  const queue: StreamChunk[] = [];
  let done = false;
  let errorMsg: string | null = null;
  let stderrBuf = "";
  let timedOut = false;
  let waiter: (() => void) | null = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };

  // When we have a threadId, the broker is mounted via .gemini/settings.json
  // and `--allowed-mcp-server-names jerome` — so the model HAS the Jerome
  // tools and should be told they're available. Without a threadId
  // (one-off quick complete), no broker, fall back to the "you don't
  // have these" framing.
  const hasBroker = !!opts.threadId;
  const toolBlock = renderMcpToolBlock(hasBroker ? "claude-code" : "gemini-cli");
  const systemPrompt = [opts.system, toolBlock].filter(Boolean).join("\n\n---\n\n");

  const proc = spawnGeminiCli({
    threadId: opts.threadId,
    systemPrompt: systemPrompt || undefined,
    cliModel: opts.model.cliModel,
    prompt,
    // Plan mode is a real --approval-mode value (read-only). The
    // claude-code provider exposes it via opts.planMode; we wire the
    // same opt-in through here.
    approvalMode: opts.planMode ? "plan" : undefined,
    cwd: opts.cwd,
  });

  if (opts.threadId) {
    liveProcesses.set(opts.threadId, proc);
  }

  const timeoutMs =
    Number.isFinite(GEMINI_TIMEOUT_MS) && GEMINI_TIMEOUT_MS > 0
      ? GEMINI_TIMEOUT_MS
      : 120_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    errorMsg = `gemini timed out after ${Math.round(timeoutMs / 1000)}s`;
    proc.kill("SIGTERM");
    wake();
  }, timeoutMs);

  let buffer = "";
  let modelId = opts.model.id;
  let inputTokens = 0;
  let outputTokens = 0;

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let evt: GeminiStreamEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      // init: { type, session_id, model } — useful for telemetry. We
      // pick up the actual model id gemini routed to (e.g.
      // "gemini-3-flash-preview" when the catalog id is
      // "gemini-cli-auto") so the `done` event reports truth.
      if (evt.type === "init") {
        if (typeof evt.model === "string" && evt.model) modelId = evt.model;
        continue;
      }

      // The CLI echoes the user's own message back as a message event
      // before starting to stream the assistant's response. Skip those.
      if (evt.type === "message" && evt.role === "assistant" && evt.content) {
        queue.push({ type: "token", text: evt.content });
      } else if (evt.type === "tool_use" && evt.tool_name && evt.tool_id) {
        queue.push({
          type: "tool_use",
          id: evt.tool_id,
          name: evt.tool_name,
          input: evt.parameters ?? {},
        });
      } else if (evt.type === "tool_result" && evt.tool_id) {
        // Gemini CLI doesn't expose the raw tool output in stream-json,
        // only the status. Push a synthetic result so the UI chip closes.
        queue.push({
          type: "tool_result",
          toolUseId: evt.tool_id,
          output: evt.status ?? "done",
          isError: evt.status === "error",
        });
      }

      if (evt.type === "result" && evt.stats) {
        inputTokens = evt.stats.input_tokens ?? inputTokens;
        outputTokens = evt.stats.output_tokens ?? outputTokens;
      }

      wake();
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0 && code !== null && !errorMsg) {
      errorMsg = `gemini exited ${code}: ${stderrBuf.slice(-500)}`;
    }
    if (timedOut && !errorMsg) {
      errorMsg = `gemini timed out after ${Math.round(timeoutMs / 1000)}s`;
    }
    if (opts.threadId && liveProcesses.get(opts.threadId) === proc) {
      liveProcesses.delete(opts.threadId);
    }
    done = true;
    wake();
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    errorMsg = err.message;
    if (opts.threadId && liveProcesses.get(opts.threadId) === proc) {
      liveProcesses.delete(opts.threadId);
    }
    done = true;
    wake();
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }

  if (errorMsg) throw new Error(errorMsg);

  yield {
    type: "done",
    model: modelId,
    inputTokens,
    outputTokens,
  };
}

// OFF BY DEFAULT. The Gemini CLI authenticates with a *personal* Google login
// (Gemini Code Assist individual). It is ALLOWED for operators who opt in
// (SPECTRE_ALLOW_GEMINI_CLI=1, or the live Settings toggle when
// SPECTRE_ALLOW_CLI_UI=1) for their own personal/dev use. The default brain is
// the provider-agnostic LiteLLM loop (providers/litellm.ts). Gate: ../cli-gate.ts.

export async function isGeminiCliAvailable(): Promise<boolean> {
  if (!cliAllowed("gemini-cli")) return false;
  return new Promise((resolve) => {
    const proc = spawn(GEMINI_CLI_BIN, ["--version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function quickCompleteGeminiCli(prompt: string): Promise<string> {
  if (!cliAllowed("gemini-cli")) {
    throw new Error(
      "Gemini CLI is disabled. Set SPECTRE_ALLOW_GEMINI_CLI=1 to opt in (uses your own Google login).",
    );
  }
  return new Promise((resolve, reject) => {
    // -o text is the default but pinning it here insulates us if
    // gemini ever changes the default. --skip-trust matches the
    // streaming path so an untrusted repo cwd doesn't reject
    // the call.
    const proc = spawn(
      GEMINI_CLI_BIN,
      ["--skip-trust", "-o", "text", "-p", prompt],
      {
        cwd: process.env.SPECTRE_REPO_PATH || process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(err.slice(-500) || `gemini exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", reject);
  });
}
