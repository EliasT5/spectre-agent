import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { StreamChunk, StreamOptions } from "./types";
import { killProcessTree } from "./process-group";
import { renderMcpToolBlock } from "../mcp-catalog";
import { cliAllowed } from "../cli-gate";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const SESSION_MARKER_DIR = join(homedir(), ".jerome", "sessions");
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "acceptEdits";

// Claude Code ships its own builtin tools; we block the ones that CONFLICT with
// Spectre's governed equivalents so the brain ALWAYS routes through our broker
// (approval-gated host/file ops) and our own scheduler — never Claude's
// ungoverned or cloud versions. Applied whenever the brain runs with the broker
// (chat + Jerome Mode); the whitelist path (bounded proactive) restricts
// even harder so it doesn't need it.
// KEPT on purpose: Read/Glob/Grep (read-only inspection), WebSearch/WebFetch
// (the web-search skill relies on them), ToolSearch (loads our deferred
// mcp__spectre__ tools — blocking it would hide them), Agent/Skill (orchestration).
// Add a name here if a new builtin ever competes with a Spectre tool.
const CONFLICTING_BUILTINS = [
  "Bash", // → broker host shell (approval-gated)
  "PowerShell", // the Windows shell name the "Bash" entry misses
  "Edit", // → broker edit
  "Write", // → broker write
  "NotebookEdit", // → broker notebook edit
  "RemoteTrigger", // Claude Code cloud routines → Spectre's own scheduler
];
const DISALLOWED_BUILTINS = CONFLICTING_BUILTINS.join(",");
const PUBLIC_GENERATED_DIR =
  process.env.SPECTRE_GENERATED_DIR ||
  join(process.cwd(), ".next/standalone/public/generated");
const GENERATED_IMAGE_RE = /(?:https?:\/\/[^\s"'<>]+)?(?:\/api)?\/generated\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?/i;

export function hasExistingSession(threadId: string): boolean {
  return existsSync(join(SESSION_MARKER_DIR, threadId));
}

export function markSessionStarted(threadId: string): void {
  mkdirSync(SESSION_MARKER_DIR, { recursive: true });
  writeFileSync(join(SESSION_MARKER_DIR, threadId), new Date().toISOString());
}

export interface SpawnClaudeOptions {
  threadId?: string;
  systemPrompt?: string;
  cwd?: string;
  permissionMode?: string;
  /** Passed through to `claude --model <id>`. Omit to use the CLI's default. */
  cliModel?: string;
  /**
   * When true, load the Jerome Mode dispatch broker alongside the regular
   * Jerome broker so the brain can delegate while still using memory and
   * local broker tools.
   */
  jeromeMode?: boolean;
  /**
   * Explicit MCP tool whitelist (P1.1 bounded proactive run). When set,
   * forces the regular broker on and passes `--allowed-tools <list>` so the
   * spawned brain can call ONLY these tools — a hard boundary, not a soft
   * permission gate. Used to give the proactive run a safe, read-mostly tool
   * surface (memory/notify/schedule-read/calendar/analytics) while structurally
   * denying bash/write/edit/workshop-mutation. The chat hot path never sets
   * this, so its behaviour is unchanged.
   */
  allowedTools?: string[];
  /** Bounded proactive run: tells the broker it is autonomous so the read-mostly whitelist tools enforce their pre-seeded hourly quota via the permission gate. Interactive chat never sets this. */
  autonomous?: boolean;
}

// Module-level registry so the /abort endpoint can kill a running claude
// process from a different request. Keyed by threadId.
const liveProcesses = new Map<string, ChildProcess>();

export function abortClaudeForThread(threadId: string): boolean {
  const proc = liveProcesses.get(threadId);
  if (!proc) return false;
  // SIGKILL on the whole process group — claude CLI plus the MCP broker it
  // spawned. SIGTERM was letting claude finish its in-flight Anthropic
  // response (~30 s of "still thinking") before exiting; the user pressed
  // Stop, so stop.
  killProcessTree(proc);
  liveProcesses.delete(threadId);
  // Also deny any pending permission requests so the MCP broker unblocks
  // instead of hanging indefinitely on the HTTP response from Jerome.
  void import("@/lib/permission/broker").then((m) => m.cancelThread(threadId));
  return true;
}

export function spawnClaudeCode(opts: SpawnClaudeOptions = {}): ChildProcess {
  // Opt-in gate: no path (chat, Jerome Mode, proactive autonomy) may spawn the
  // subscription-backed CLI unless the operator explicitly opted in. Detection is
  // already gated (isClaudeCodeAvailable), so the router won't reach here; this
  // guards direct callers (e.g. proactive.ts) too. See cli-gate.ts.
  if (!cliAllowed("claude-code")) {
    throw new Error(
      "Claude Code CLI is disabled. Set SPECTRE_ALLOW_CLAUDE_CLI=1 to enable the " +
        "Claude Code brain (uses your own Claude subscription). Alternatively, use the " +
        "provider-agnostic LiteLLM brain (SPECTRE_LITELLM_URL).",
    );
  }
  const hasAllowedTools = !!opts.allowedTools && opts.allowedTools.length > 0;
  const brokerActive =
    !!opts.threadId &&
    !opts.permissionMode /* plan-mode wins over broker */ &&
    (process.env.SPECTRE_MCP_BROKER === "1" ||
      hasAllowedTools);

  // When the broker is on, Claude's own permission layer is redundant — our
  // MCP server already gates every write-side call via the UI modal. Use
  // bypassPermissions so Claude doesn't prompt for each mcp__spectre__* tool.
  // Same reasoning for the Jerome-Mode brain spawn.
  const permissionMode =
    opts.permissionMode ||
    (opts.jeromeMode || brokerActive ? "bypassPermissions" : PERMISSION_MODE);
  const toolBlock =
    opts.jeromeMode || brokerActive
      ? renderMcpToolBlock("claude-code", { jeromeMode: opts.jeromeMode })
      : "";
  const effectiveSystemPrompt = toolBlock
    ? [opts.systemPrompt, toolBlock].filter(Boolean).join("\n\n---\n\n")
    : opts.systemPrompt;

  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];

  // Big payloads (the soul+tools system prompt, the MCP config JSON) must NOT
  // ride in argv — Windows caps a command line at ~32 KB and the Jerome-Mode
  // tool block alone blows past it (spawn ENAMETOOLONG). Write them to temp
  // files and pass paths instead; the claude CLI accepts --system-prompt-file,
  // --append-system-prompt-file, and a file path for --mcp-config. Temp dirs
  // are cleaned up when the process exits.
  const spawnTempDirs: string[] = [];
  const writeArgFile = (name: string, contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "jerome-spawn-"));
    spawnTempDirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, contents, "utf-8");
    return file;
  };

  if (opts.cliModel) {
    args.push("--model", opts.cliModel);
  }

  const brokerEnv = (threadId: string | undefined, extra?: Record<string, string>) => ({
    SPECTRE_THREAD_ID: threadId ?? "",
    SPECTRE_APP_URL: process.env.SPECTRE_APP_URL || "http://127.0.0.1:8787",
    SPECTRE_SERVICE_TOKEN: process.env.SPECTRE_SERVICE_TOKEN || "",
    // So data-tools + user skills (read from the data dir) work on this path too.
    SPECTRE_DATA_DIR: process.env.SPECTRE_DATA_DIR || "",
    SPECTRE_TOOL_ENV_ALLOW: process.env.SPECTRE_TOOL_ENV_ALLOW || "",
    // The core now gates /api/* on CORE_TOKEN; the broker calls back into the
    // core (permissions, memory, dispatch) so it must carry the token too.
    CORE_TOKEN: process.env.CORE_TOKEN || "",
    CODEX_CLI_BIN:
      process.env.CODEX_CLI_BIN && process.env.CODEX_CLI_BIN !== "codex"
        ? process.env.CODEX_CLI_BIN
        : "/usr/bin/codex",
    ...(opts.autonomous ? { SPECTRE_AUTONOMOUS: "1", SPECTRE_AUTONOMOUS_THREAD: threadId ?? "" } : {}),
    ...extra,
  });

  // Jerome Mode brain spawn: load the regular broker with its full toolset
  // and add dispatch_to_model to that same `jerome` server. Keeping one MCP
  // server avoids Claude Code's deferred ToolSearch hiding tools on a
  // secondary broker.
  if (opts.jeromeMode) {
    const brokerPath =
      process.env.SPECTRE_MCP_BROKER_PATH ||
      join(process.cwd(), "spectre-mcp-broker/index.mjs");
    const jmConfig = {
      mcpServers: {
        spectre: {
          command: process.execPath,
          args: [brokerPath],
          env: brokerEnv(opts.threadId, { SPECTRE_ENABLE_DISPATCH_TOOL: "1" }),
        },
      },
    };
    args.push("--mcp-config", writeArgFile("mcp.json", JSON.stringify(jmConfig)));
    args.push("--disallowed-tools", DISALLOWED_BUILTINS);
  }

  // Optional MCP permission broker. When SPECTRE_MCP_BROKER=1 we spawn
  // spectre-mcp-broker inline and re-route write-side tools through it so
  // the user can approve/deny each call in the UI. Set SPECTRE_MCP_BROKER=0
  // to fall back to the old behaviour (Claude's built-in Bash/Edit/Write).
  if (!opts.jeromeMode && brokerActive) {
    const brokerPath =
      process.env.SPECTRE_MCP_BROKER_PATH ||
      join(process.cwd(), "spectre-mcp-broker/index.mjs");
    const brokerConfig = {
      mcpServers: {
        spectre: {
          command: process.execPath,
          args: [brokerPath],
          env: brokerEnv(opts.threadId),
        },
      },
    };
    args.push("--mcp-config", writeArgFile("mcp.json", JSON.stringify(brokerConfig)));
    if (hasAllowedTools) {
      // Bounded run (e.g. proactive): the brain sees ONLY these MCP tools —
      // no shell, no edit/write, no workshop-mutation. A whitelist trumps
      // disallow, so this is a hard structural boundary, not a soft gate.
      args.push("--allowed-tools", opts.allowedTools!.join(","));
    } else {
      // Conflicting Claude builtins → Spectre's broker + scheduler (see CONFLICTING_BUILTINS).
      args.push("--disallowed-tools", DISALLOWED_BUILTINS);
    }
  }

  if (opts.threadId) {
    if (hasExistingSession(opts.threadId)) {
      args.push("--resume", opts.threadId);
      if (effectiveSystemPrompt) {
        args.push("--append-system-prompt-file", writeArgFile("system.txt", effectiveSystemPrompt));
      }
    } else {
      args.push("--session-id", opts.threadId);
      if (effectiveSystemPrompt) {
        args.push("--system-prompt-file", writeArgFile("system.txt", effectiveSystemPrompt));
      }
      // Marker is written by streamClaudeCode AFTER claude exits cleanly.
      // If we wrote it here and the first turn failed, every subsequent
      // turn would --resume a session claude never persisted, producing
      // "No conversation found with session ID: ..." on every send.
    }
  } else if (effectiveSystemPrompt) {
    args.push("--system-prompt", effectiveSystemPrompt);
  }

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: opts.cwd || process.env.SPECTRE_REPO_PATH || process.cwd(),
    env: {
      ...process.env,
      CODEX_CLI_BIN:
        process.env.CODEX_CLI_BIN && process.env.CODEX_CLI_BIN !== "codex"
          ? process.env.CODEX_CLI_BIN
          : "/usr/bin/codex",
    },
    stdio: ["pipe", "pipe", "pipe"],
    // Run claude in its own process group so the Stop button can SIGKILL
    // claude AND its MCP broker child in one shot via process.kill(-pid).
    // (On Windows there are no process groups; killProcessTree falls back to
    // taskkill /T, so detached is harmless there.)
    detached: true,
  });

  // Remove the temp arg files once claude exits (it has read them at startup).
  if (spawnTempDirs.length > 0) {
    const cleanup = () => {
      for (const dir of spawnTempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    };
    proc.once("close", cleanup);
    proc.once("error", cleanup);
  }

  return proc;
}

function containsGeneratedImageUrl(value: unknown): boolean {
  if (typeof value === "string") return GENERATED_IMAGE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsGeneratedImageUrl);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsGeneratedImageUrl);
  }
  return false;
}

function latestGeneratedImageUrl(): string | null {
  try {
    const newest = readdirSync(PUBLIC_GENERATED_DIR)
      .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name))
      .map((name) => {
        const path = join(PUBLIC_GENERATED_DIR, name);
        return { name, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return newest ? `/generated/${newest.name}` : null;
  } catch {
    return null;
  }
}

function enrichGeneratedImageResult(toolName: string | undefined, output: unknown): unknown {
  if (!toolName || !/openai.*image|image/i.test(toolName)) return output;
  if (containsGeneratedImageUrl(output)) return output;
  const url = latestGeneratedImageUrl();
  if (!url) return output;
  if (typeof output === "string") return `${output}\n\nImage URL: ${url}`;
  if (Array.isArray(output)) return [...output, { type: "text", text: `Image URL: ${url}` }];
  if (output && typeof output === "object") {
    return { ...(output as Record<string, unknown>), generated_image_url: url };
  }
  return `Image URL: ${url}`;
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  message?: {
    /** Anthropic assigns a UUID per assistant message; we use it as the
     *  text-block dedupe namespace. Always present on assistant events. */
    id?: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  result?: string;
}

async function* streamClaudeCodeOnce(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    throw new Error("streamClaudeCode: no user message in conversation");
  }

  const isNewSession =
    !!opts.threadId && !hasExistingSession(opts.threadId);

  const proc = spawnClaudeCode({
    threadId: opts.threadId,
    systemPrompt: opts.system,
    cliModel: opts.model.cliModel,
    permissionMode: opts.planMode ? "plan" : undefined,
    jeromeMode: opts.jeromeMode,
    cwd: opts.cwd,
  });

  if (opts.threadId) {
    liveProcesses.set(opts.threadId, proc);
  }

  const userEvent = {
    type: "user",
    message: { role: "user", content: lastUser.content },
  };
  proc.stdin!.write(JSON.stringify(userEvent) + "\n");
  proc.stdin!.end();

  let buffer = "";
  const emittedTextPerBlock = new Map<string, string>();
  const queue: StreamChunk[] = [];
  let modelId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let done = false;
  let errorMsg: string | null = null;
  let stderrBuf = "";
  const toolNamesById = new Map<string, string>();

  const flush = (resolver?: () => void) => {
    if (resolver) resolver();
  };
  let waiter: (() => void) | null = null;

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let evt: StreamJsonEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      if (evt.type === "system") {
        if (evt.model) modelId = evt.model;
        continue;
      }

      if (evt.type === "assistant" && evt.message) {
        if (evt.message.model) modelId = evt.message.model;
        let blockIdx = 0;
        for (const block of evt.message.content ?? []) {
          if (block.type === "text" && block.text) {
            // Text blocks don't carry their own id in the CLI stream-json
            // format, but the surrounding assistant *message* always does.
            // Keying by `${messageId}-b${blockIdx}` keeps streamed updates
            // to the same block deduped while guaranteeing that text from a
            // later turn (new message id) can never collide with the first
            // turn's preamble — the previous `t${turnId}b${blockIdx}` scheme
            // dropped second-turn text whenever turnId failed to increment.
            const messageKey = evt.message?.id ?? "msg";
            const key = block.id ?? `${messageKey}-b${blockIdx}`;
            const prev = emittedTextPerBlock.get(key) ?? "";
            if (block.text.length > prev.length && block.text.startsWith(prev)) {
              const delta = block.text.slice(prev.length);
              emittedTextPerBlock.set(key, block.text);
              queue.push({ type: "token", text: delta });
            } else if (!emittedTextPerBlock.has(key)) {
              emittedTextPerBlock.set(key, block.text);
              queue.push({ type: "token", text: block.text });
            }
          } else if (block.type === "tool_use" && block.id && block.name) {
            toolNamesById.set(block.id, block.name);
            queue.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
          blockIdx++;
        }
        if (evt.message.usage) {
          inputTokens = evt.message.usage.input_tokens ?? inputTokens;
          outputTokens = evt.message.usage.output_tokens ?? outputTokens;
        }
      }

      if (evt.type === "user" && evt.message) {
        // Tool results arrive — forward each one downstream so the UI can
        // close its tool chip. (The dedupe namespace no longer relies on
        // counting turns; assistant message ids handle that now.)
        for (const block of evt.message.content ?? []) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const output = enrichGeneratedImageResult(
              toolNamesById.get(block.tool_use_id),
              block.content
            );
            queue.push({
              type: "tool_result",
              toolUseId: block.tool_use_id,
              output,
              isError: block.is_error,
            });
          }
        }
      }

      if (evt.type === "result") {
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens ?? inputTokens;
          outputTokens = evt.usage.output_tokens ?? outputTokens;
        }
      }

      flush(waiter ?? undefined);
      waiter = null;
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });

  proc.on("close", (code) => {
    if (code !== 0 && code !== null && !errorMsg) {
      errorMsg = `claude exited ${code}: ${stderrBuf.slice(-500)}`;
    }
    if (opts.threadId) {
      if (code === 0 && !errorMsg && isNewSession) {
        markSessionStarted(opts.threadId);
      } else if (
        errorMsg &&
        /No conversation found with session ID/i.test(errorMsg)
      ) {
        // Self-heal: claude has no record of this session (likely a poison
        // marker from a prior failed first turn). Drop the marker so the
        // next send starts fresh with --session-id.
        try {
          unlinkSync(join(SESSION_MARKER_DIR, opts.threadId));
        } catch { /* marker may already be absent (ENOENT) — that's fine */ }
      }
      if (liveProcesses.get(opts.threadId) === proc) {
        liveProcesses.delete(opts.threadId);
      }
    }
    done = true;
    flush(waiter ?? undefined);
    waiter = null;
  });

  proc.on("error", (err) => {
    errorMsg = err.message;
    if (opts.threadId && liveProcesses.get(opts.threadId) === proc) {
      liveProcesses.delete(opts.threadId);
    }
    done = true;
    flush(waiter ?? undefined);
    waiter = null;
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
    model: modelId ?? "claude-code",
    inputTokens,
    outputTokens,
  };
}

/**
 * Public entry point. Delegates to streamClaudeCodeOnce, retrying once if
 * the first turn dies with a recoverable session-state mismatch:
 *   - "Session ID ... already in use": claude has the session but our
 *     marker doesn't — write the marker and re-run with --resume.
 *   - "No conversation found with session ID ...": our marker points at a
 *     session claude doesn't have — drop the marker and re-run with
 *     --session-id (fresh session under the same thread).
 *
 * Without this, a SIGTERM mid-turn (Stop button, dropped connection) leaves
 * one side of the marker/session pair out of sync and the user gets stuck
 * on every subsequent send until they manually reset the thread.
 */
export async function* streamClaudeCode(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  try {
    yield* streamClaudeCodeOnce(opts);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!opts.threadId) throw err;

    if (/Session ID .* (?:is\s+)?already in use/i.test(msg)) {
      markSessionStarted(opts.threadId);
      yield* streamClaudeCodeOnce(opts);
      return;
    }
    if (/No conversation found with session ID/i.test(msg)) {
      try {
        unlinkSync(join(SESSION_MARKER_DIR, opts.threadId));
      } catch { /* marker may already be absent (ENOENT) — that's fine */ }
      yield* streamClaudeCodeOnce(opts);
      return;
    }

    throw err;
  }
}

// ── Opt-in gate (OFF BY DEFAULT) ─────────────────────────────────────────────
// This adapter drives the `claude` CLI, which authenticates with a *personal*
// Claude subscription. It is OFF unless the operator explicitly opts in. The
// gate itself now lives in ../cli-gate.ts (single source of truth across the AI
// layer): the SPECTRE_ALLOW_CLAUDE_CLI env flag → optional live Settings override
// (SPECTRE_ALLOW_CLI_UI) — gated the same way as Codex and Gemini. Call
// cliAllowed("claude-code").
//
// The production-ready default brain is the provider-agnostic LiteLLM loop
// (providers/litellm.ts), which runs on metered API keys / self-hosted models
// the operator owns. See the README footnote.

export async function isClaudeCodeAvailable(): Promise<boolean> {
  // Off by default — never advertise the provider to the router/detector
  // unless explicitly opted in.
  if (!cliAllowed("claude-code")) return false;
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ["--version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function quickCompleteClaudeCode(prompt: string): Promise<string> {
  // Defence-in-depth opt-in gate at the spawn boundary, for parity with
  // quickCompleteCodexCli / quickCompleteGeminiCli (and spawnClaudeCode).
  if (!cliAllowed("claude-code")) {
    throw new Error(
      "Claude Code CLI is disabled. Set SPECTRE_ALLOW_CLAUDE_CLI=1 to opt in (uses your own Claude subscription).",
    );
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, ["--print", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(err || `claude exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", reject);
  });
}
