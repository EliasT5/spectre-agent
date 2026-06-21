import { spawn, type ChildProcess } from "child_process";
import type { ChatMessage, StreamChunk, StreamOptions } from "./types";
import { killProcessTree } from "./process-group";
import { renderMcpToolBlock } from "../mcp-catalog";
import { cliAllowed } from "../cli-gate";

const CODEX_BIN = process.env.CODEX_CLI_BIN || "codex";

/**
 * Codex CLI (Rust, v0.125+) — non-interactive via `codex exec`.
 *
 * Invocation shape:
 *   codex exec --full-auto --json --ephemeral --skip-git-repo-check [-m <model>] <prompt>
 *
 * JSONL event shapes we care about (verified against v0.125.0):
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}  → text output
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}  → done + usage
 *   {"type":"error","message":"..."}                                        → surface as error
 *
 * No streaming deltas — the CLI emits the full text in one `item.completed`
 * event when the model finishes. The text lands all at once in the UI (same
 * behaviour as a non-streaming API call). Acceptable for a coding agent.
 *
 * Session resumption: Codex doesn't expose a UUID-based --resume for
 * exec mode. We serialize the full thread history into the prompt on every
 * turn — same pattern as gemini-cli.ts.
 *
 * System prompt: no --system flag exists. We embed it as a preamble block
 * inside the prompt string so it's model-agnostic and length-safe.
 */

function buildPromptFromHistory(system: string, messages: ChatMessage[]): string {
  if (messages.length === 0) return "";

  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastIdx = i; break; }
  }
  if (lastIdx < 0) return "";

  const history = messages.slice(0, lastIdx);
  const current = messages[lastIdx];
  const parts: string[] = [];

  if (system) {
    parts.push(`[System Instructions]\n${system}\n[/System Instructions]`);
  }

  if (history.length > 0) {
    const transcript = history
      .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
      .join("\n\n");
    parts.push(`[Conversation History — context only]\n\n${transcript}`);
  }

  parts.push(`[Active Turn]\n\nUser: ${current.content}`);
  return parts.join("\n\n");
}

const liveProcesses = new Map<string, ChildProcess>();

export function abortCodexForThread(threadId: string): boolean {
  const proc = liveProcesses.get(threadId);
  if (!proc) return false;
  killProcessTree(proc);
  liveProcesses.delete(threadId);
  return true;
}

interface CodexJsonEvent {
  type: string;
  item?: { id?: string; type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string };
  message?: string;
}

export async function* streamCodexCli(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  // Defence-in-depth opt-in gate at the spawn boundary: never spawn the
  // CLI even if a caller reached here without a gate check (mirrors spawnClaudeCode).
  if (!cliAllowed("codex-cli")) {
    throw new Error(
      "Codex CLI is disabled. Set SPECTRE_ALLOW_CODEX_CLI=1 to enable it (uses your own ChatGPT subscription), " +
        "or use the provider-agnostic LiteLLM brain instead.",
    );
  }
  // Broker is mounted only when we have a real chat threadId — quick
  // completes don't get one and shouldn't try to spin up an MCP server.
  const hasBroker = !!opts.threadId;
  const toolBlock = renderMcpToolBlock(hasBroker ? "claude-code" : "codex-cli");
  const system = [opts.system, toolBlock].filter(Boolean).join("\n\n---\n\n");
  const prompt = buildPromptFromHistory(system, opts.messages);
  if (!prompt) throw new Error("streamCodexCli: no user message in conversation");

  const queue: StreamChunk[] = [];
  let done = false;
  let errorMsg: string | null = null;
  let stderrBuf = "";
  let waiter: (() => void) | null = null;
  const wake = () => { const w = waiter; waiter = null; if (w) w(); };

  const args: string[] = [
    "exec",
    "--full-auto",
    "--json",
    "--ephemeral",          // don't persist session files to disk
    "--skip-git-repo-check",
  ];
  if (opts.model.cliModel) args.push("-m", opts.model.cliModel);
  // Codex valid efforts: none | minimal | low | medium | high | xhigh
  if (opts.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${opts.reasoningEffort}`);
  }

  // MCP — register the Jerome broker via per-spawn `-c` overrides so
  // we never touch ~/.codex/config.toml. Each session carries its own
  // mcp_servers.jerome entry with thread-specific env baked in.
  const brokerPath =
    process.env.SPECTRE_MCP_BROKER_PATH ||
    `${process.cwd()}/spectre-mcp-broker/index.mjs`;
  if (hasBroker) {
    const env = {
      SPECTRE_THREAD_ID: opts.threadId!,
      SPECTRE_APP_URL: process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000",
      SPECTRE_SERVICE_TOKEN: process.env.SPECTRE_SERVICE_TOKEN || "",
    };
    const tomlEnv = `{ ${Object.entries(env)
      .map(([k, v]) => `${k} = "${String(v).replace(/"/g, '\\"')}"`)
      .join(", ")} }`;
    args.push("-c", `mcp_servers.jerome.command="node"`);
    args.push("-c", `mcp_servers.jerome.args=["${brokerPath}"]`);
    args.push("-c", `mcp_servers.jerome.env=${tomlEnv}`);
  }

  args.push(prompt);

  console.log(`[codex] spawn ${CODEX_BIN} ${args.slice(0, args.length - 1).join(" ")} <prompt:${prompt.length} chars>`);
  const proc = spawn(CODEX_BIN, args, {
    cwd: opts.cwd || process.env.SPECTRE_REPO_PATH || process.cwd(),
    env: { ...process.env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  if (opts.threadId) liveProcesses.set(opts.threadId, proc);

  let buf = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const eventCounts: Record<string, number> = {};

  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let evt: CodexJsonEvent;
      try { evt = JSON.parse(line); } catch {
        console.log(`[codex] non-json stdout: ${line.slice(0, 200)}`);
        continue;
      }

      eventCounts[evt.type] = (eventCounts[evt.type] ?? 0) + 1;

      if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
        queue.push({ type: "token", text: evt.item.text });
      }

      if (evt.type === "turn.completed") {
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens ?? 0;
          outputTokens = evt.usage.output_tokens ?? 0;
        }
        // Codex keeps the websocket alive after the turn is complete (its
        // own retry loop reconnects to api.openai.com indefinitely). For a
        // chat turn, that's wasted: the model has already responded. Kill
        // the process so the stream finishes and the user can send another
        // message immediately.
        try { proc.kill("SIGTERM"); } catch { /* SIGTERM on an already-exited process throws; harmless */ }
      }

      if (evt.type === "error") {
        const msg = evt.error?.message ?? evt.message ?? "unknown codex error";
        console.log(`[codex] error event: ${msg}`);
        if (!errorMsg) errorMsg = msg;
      }

      wake();
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });

  proc.on("close", (code) => {
    console.log(
      `[codex] close code=${code} events=${JSON.stringify(eventCounts)} ` +
      `tokens=${queue.length} stderr=${stderrBuf.slice(-300)}`
    );
    if (code !== 0 && code !== null && !errorMsg) {
      errorMsg = `codex exited ${code}: ${stderrBuf.slice(-400)}`;
    }
    if (opts.threadId && liveProcesses.get(opts.threadId) === proc) {
      liveProcesses.delete(opts.threadId);
    }
    done = true;
    wake();
  });

  proc.on("error", (err) => {
    console.log(`[codex] proc error: ${err.message}`);
    errorMsg = err.message;
    if (opts.threadId && liveProcesses.get(opts.threadId) === proc) {
      liveProcesses.delete(opts.threadId);
    }
    done = true;
    wake();
  });

  while (true) {
    while (queue.length > 0) yield queue.shift()!;
    if (done) break;
    await new Promise<void>((resolve) => { waiter = resolve; });
  }

  // Only throw if we got no useful output AND there's an error
  if (errorMsg && outputTokens === 0 && queue.length === 0) throw new Error(errorMsg);

  yield {
    type: "done",
    model: opts.model.cliModel ?? "codex",
    inputTokens,
    outputTokens,
  };
}

// OFF BY DEFAULT. The Codex CLI authenticates with a *ChatGPT* subscription (see
// openai-tools.mjs: "no API key required"). It is ALLOWED for operators who opt
// in (SPECTRE_ALLOW_CODEX_CLI=1, or the live Settings toggle when
// SPECTRE_ALLOW_CLI_UI=1) for their own personal/dev use. The default brain is
// the provider-agnostic LiteLLM loop (providers/litellm.ts). Gate: ../cli-gate.ts.

export async function isCodexCliAvailable(): Promise<boolean> {
  if (!cliAllowed("codex-cli")) return false;
  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, ["--version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function quickCompleteCodexCli(prompt: string): Promise<string> {
  if (!cliAllowed("codex-cli")) {
    throw new Error(
      "Codex CLI is disabled. Set SPECTRE_ALLOW_CODEX_CLI=1 to opt in (uses your own ChatGPT subscription).",
    );
  }
  return new Promise((resolve, reject) => {
    const args = [
      "exec", "--full-auto", "--json", "--ephemeral", "--skip-git-repo-check", prompt,
    ];
    const proc = spawn(CODEX_BIN, args, {
      cwd: process.env.SPECTRE_REPO_PATH || process.cwd(),
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.slice(-400) || `codex exited ${code}`));
        return;
      }
      let text = "";
      for (const line of out.split("\n")) {
        try {
          const evt: CodexJsonEvent = JSON.parse(line.trim());
          if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
            text = evt.item.text;
          }
        } catch { /* skip non-JSON lines */ }
      }
      resolve(text.trim() || out.trim());
    });
    proc.on("error", reject);
  });
}
