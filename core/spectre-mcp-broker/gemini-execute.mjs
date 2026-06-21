/**
 * gemini.execute — MCP tool that hands a tightly-scoped imperative task
 * to the local `gemini` CLI and returns its final assistant output.
 *
 * Architecture: this is the executor end of an "orchestrator + executor"
 * split. The caller (Claude Code in chat, the workshop worker, or any
 * other MCP-aware client) is expected to do the *understanding* — read
 * the relevant code, build context, then commit to a precise imperative
 * instruction. Gemini does NOT get to interpret intent. The `task`
 * validation heuristic below enforces that contract: open-ended
 * questions are refused.
 *
 * Spawn shape (mirrors src/lib/ai/providers/gemini-cli.ts):
 *   gemini --skip-trust -o stream-json --approval-mode <mode>
 *          [-m <cli-model>] [--include-directories <comma-list>]
 *          -p <task>
 *
 * Stream-json event shape (verified against gemini v0.39.1 — see
 * GEMINI_FIELD_REPORT.md §2):
 *   {"type":"init","session_id":"…","model":"auto-gemini-3"}
 *   {"type":"message","role":"user","content":"…"}
 *   {"type":"message","role":"assistant","content":"…","delta":true}
 *   {"type":"result","status":"success","stats":{…}}
 *
 * Cancellation: the MCP SDK threads an AbortSignal through `extra.signal`
 * on every tool call. We listen on it and SIGTERM the child process when
 * the caller cancels.
 *
 * Hard timeout: 5 minutes. Beyond that we SIGKILL and surface a partial
 * result with `error: "timeout after 300s"`.
 *
 * Output cap: 256 KiB on the concatenated assistant text. If the cap is
 * hit we set `truncated: true` on the response.
 */

import { spawn } from "node:child_process";
import { posix as pathPosix } from "node:path";
import { z } from "zod";

const invalidResult = (err) => ({
  isError: true,
  content: [{ type: "text", text: err }],
  structuredContent: {
    output: "",
    exit_code: -1,
    stats: { input_tokens: 0, output_tokens: 0, ms: 0 },
    error: err,
  },
});

const GEMINI_CLI_BIN = process.env.GEMINI_CLI_BIN || "gemini";
const DEFAULT_APPROVAL_MODE = "auto_edit";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const OUTPUT_CAP_BYTES = 256 * 1024; // 256 KiB
const FILES_ROOT = process.env.SPECTRE_FILES_ROOT || process.env.SPECTRE_REPO_PATH || process.cwd();

// ─────────────────────────── task validation ───────────────────────────

/**
 * Imperative-detection heuristic.
 *
 * Accept if the first whitespace-delimited token is a known action verb
 * OR the task contains an action token anywhere (write, edit, translate,
 * generate, produce, convert, rewrite, etc.). Reject if it ends with `?`
 * or is too short (≤ 5 words and has no action token).
 *
 * The point is to refuse "what do you think about X" / "is this Y" /
 * "explain Z" — open-ended questions that would force gemini to
 * interpret intent. Action verbs commit the caller to a specific
 * deliverable.
 */
const ACTION_TOKENS = new Set([
  "write",
  "edit",
  "translate",
  "generate",
  "produce",
  "convert",
  "rewrite",
  "refactor",
  "fix",
  "implement",
  "add",
  "remove",
  "delete",
  "rename",
  "extract",
  "summarize",
  "summarise",
  "draft",
  "create",
  "build",
  "compile",
  "format",
  "lint",
  "transform",
  "patch",
  "update",
  "replace",
  "compose",
  "outline",
  "render",
  "emit",
  "synthesize",
  "synthesise",
  "produce",
  "list",
  "tabulate",
  "classify",
  "label",
  "annotate",
  "explain", // borderline but accepted: "explain X in 2 lines" is a deliverable
  "describe",
]);

const VERB_LIKE_FIRST = new Set([
  ...ACTION_TOKENS,
  // light additions for first-token detection
  "make",
  "do",
  "run",
  "find",
  "show",
  "give",
  "get",
  "put",
  "move",
  "copy",
  "split",
  "merge",
  "sort",
  "filter",
  "map",
  "fold",
  "expand",
  "contract",
  "shrink",
  "trim",
  "pad",
  "wrap",
  "unwrap",
  "flatten",
  "deduplicate",
  "dedupe",
  "validate",
  "verify",
  "check",
  "test",
  "stub",
  "mock",
  "scaffold",
  "port",
  "migrate",
  "translate",
  "compose",
  "register",
  "expose",
  "wire",
  "hook",
  "attach",
  "detach",
  "bind",
  "configure",
]);

/**
 * @param {string} task
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateImperative(task) {
  if (typeof task !== "string") {
    return { ok: false, reason: "task must be a string" };
  }
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "task is empty" };
  }
  if (trimmed.endsWith("?")) {
    return {
      ok: false,
      reason: "task ends with '?' — looks like a question, not an imperative",
    };
  }
  const words = trimmed.split(/\s+/);
  const firstToken = (words[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  const lower = trimmed.toLowerCase();
  const containsActionToken = [...ACTION_TOKENS].some((t) =>
    new RegExp(`\\b${t}\\b`, "i").test(lower)
  );
  const startsWithVerb = VERB_LIKE_FIRST.has(firstToken);

  if (startsWithVerb) return { ok: true };
  if (containsActionToken && words.length > 5) return { ok: true };
  if (containsActionToken) {
    return {
      ok: false,
      reason: `task is too short (${words.length} words) — give gemini enough context to act on the imperative`,
    };
  }
  return {
    ok: false,
    reason:
      "task does not read as an imperative — start with an action verb (write/edit/translate/generate/refactor/fix/…) and avoid open-ended questions",
  };
}

// ─────────────────────────── files validation ──────────────────────────

/**
 * @param {string[]} files
 * @returns {{ ok: true, abs: string[] } | { ok: false, reason: string }}
 */
export function validateFiles(files) {
  const abs = [];
  for (const raw of files) {
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, reason: `invalid file entry: ${JSON.stringify(raw)}` };
    }
    if (raw.includes("..")) {
      return { ok: false, reason: `path traversal not allowed: ${raw}` };
    }
    // Validate as a POSIX path — the broker runs on the Mini-PC (Linux)
    // and the FILES_ROOT is a Linux absolute path. Using node:path's
    // platform-specific helpers would mangle the path on Windows
    // dev-machines (resolve() prepends C:\, normalize() flips slashes).
    if (!pathPosix.isAbsolute(raw)) {
      return {
        ok: false,
        reason: `file path must be absolute and under ${FILES_ROOT}: ${raw}`,
      };
    }
    const norm = pathPosix.normalize(raw);
    if (!(norm === FILES_ROOT || norm.startsWith(FILES_ROOT + "/"))) {
      return {
        ok: false,
        reason: `file path must be under ${FILES_ROOT}: ${raw}`,
      };
    }
    abs.push(norm);
  }
  return { ok: true, abs };
}

// ─────────────────────────── model mapping ─────────────────────────────

/** @type {Record<string, string | null>} */
const MODEL_MAP = {
  flash: "gemini-2.5-flash-lite",
  pro: "gemini-2.5-pro",
  auto: null, // omit -m, let gemini pick
};

// ─────────────────────────── the runner ────────────────────────────────

/**
 * Build the args array for the gemini spawn. Exported for testing.
 *
 * @param {object} p
 * @param {string} p.prompt
 * @param {string} p.approvalMode
 * @param {string|null} p.cliModel
 * @param {string[]} p.includeDirs
 */
export function buildGeminiArgs({ prompt, approvalMode, cliModel, includeDirs }) {
  const args = [
    "--skip-trust",
    "-o",
    "stream-json",
    "--approval-mode",
    approvalMode,
  ];
  if (cliModel) args.push("-m", cliModel);
  if (includeDirs.length > 0) {
    args.push("--include-directories", includeDirs.join(","));
  }
  args.push("-p", prompt);
  return args;
}

/**
 * Parse a single stream-json line into a delta of state.
 * Pure function — exported for unit testing.
 *
 * @param {string} line
 * @param {{ assistant: string, inputTokens: number, outputTokens: number }} state
 * @returns {{ assistant: string, inputTokens: number, outputTokens: number }}
 */
export function applyStreamLine(line, state) {
  const trimmed = line.trim();
  if (!trimmed) return state;
  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return state;
  }
  if (evt && evt.type === "message" && evt.role === "assistant" && typeof evt.content === "string") {
    return { ...state, assistant: state.assistant + evt.content };
  }
  if (evt && evt.type === "result" && evt.stats) {
    return {
      ...state,
      inputTokens: typeof evt.stats.input_tokens === "number" ? evt.stats.input_tokens : state.inputTokens,
      outputTokens: typeof evt.stats.output_tokens === "number" ? evt.stats.output_tokens : state.outputTokens,
    };
  }
  // init / user-echo message / unknown — ignore
  return state;
}

/**
 * @param {object} p
 * @param {string} p.task
 * @param {string} [p.context]
 * @param {string[]} [p.files]
 * @param {"flash"|"pro"|"auto"} [p.model]
 * @param {"auto_edit"|"yolo"|"plan"} [p.approval_mode]
 * @param {"text"|"json"} [p.format]
 * @param {AbortSignal} [p.signal]
 */
async function runGemini(p) {
  const model = p.model ?? "auto";
  const approvalMode = p.approval_mode ?? DEFAULT_APPROVAL_MODE;
  const format = p.format ?? "text";
  const cliModel = MODEL_MAP[model] ?? null;

  // Compose prompt body
  let promptBody = p.task;
  if (p.context && p.context.length > 0) {
    promptBody = `[Context]\n\n${p.context}\n\n[Task]\n\n${p.task}`;
  }
  if (format === "json") {
    promptBody += `\n\nReturn ONLY a JSON object with no surrounding prose or code fences.`;
  }

  const args = buildGeminiArgs({
    prompt: promptBody,
    approvalMode,
    cliModel,
    includeDirs: p.files ?? [],
  });

  const start = Date.now();
  /** @type {{ output: string; truncated: boolean; exit_code: number; stats: { input_tokens: number, output_tokens: number, ms: number }; error?: string; partial_output?: string; parse_error?: string; parsed?: unknown; stderr_tail?: string }} */
  const result = await new Promise((resolveP) => {
    const proc = spawn(GEMINI_CLI_BIN, args, {
      cwd: process.env.SPECTRE_REPO_PATH || process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    /** @type {{ assistant: string, inputTokens: number, outputTokens: number }} */
    let state = { assistant: "", inputTokens: 0, outputTokens: 0 };
    let truncated = false;
    let stderrBuf = "";
    let lineBuf = "";
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    };
    if (p.signal) {
      if (p.signal.aborted) onAbort();
      else p.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString("utf-8");
      let nl;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        const next = applyStreamLine(line, state);
        // enforce output cap on assistant text
        if (Buffer.byteLength(next.assistant, "utf-8") > OUTPUT_CAP_BYTES) {
          // truncate to cap
          const buf = Buffer.from(next.assistant, "utf-8").subarray(0, OUTPUT_CAP_BYTES);
          state = { ...next, assistant: buf.toString("utf-8") };
          truncated = true;
          try { proc.stdout.pause(); } catch { /* noop */ }
        } else {
          state = next;
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf-8");
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (p.signal) p.signal.removeEventListener("abort", onAbort);
      const ms = Date.now() - start;
      const exitCode = typeof code === "number" ? code : -1;

      const base = {
        output: state.assistant,
        truncated,
        exit_code: exitCode,
        stats: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          ms,
        },
      };

      if (timedOut) {
        resolveP({
          ...base,
          error: `timeout after ${Math.round(TIMEOUT_MS / 1000)}s`,
          partial_output: state.assistant,
          stderr_tail: stderrBuf.slice(-500) || undefined,
        });
        return;
      }
      if (aborted) {
        resolveP({
          ...base,
          error: "cancelled by caller",
          partial_output: state.assistant,
          stderr_tail: stderrBuf.slice(-500) || undefined,
        });
        return;
      }
      if (exitCode !== 0) {
        resolveP({
          ...base,
          error: `gemini exited ${exitCode}`,
          stderr_tail: stderrBuf.slice(-500) || undefined,
        });
        return;
      }

      // format=json: try to parse, attach parse_error on failure
      if (format === "json") {
        const trimmed = state.assistant.trim();
        try {
          const parsed = JSON.parse(trimmed);
          resolveP({ ...base, parsed });
        } catch (err) {
          resolveP({
            ...base,
            parse_error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      resolveP(base);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (p.signal) p.signal.removeEventListener("abort", onAbort);
      resolveP({
        output: state.assistant,
        truncated,
        exit_code: -1,
        stats: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          ms: Date.now() - start,
        },
        error: `failed to spawn gemini: ${err.message}`,
      });
    });
  });

  return result;
}

// ─────────────────────────── registration ──────────────────────────────

const inputSchema = {
  task: z
    .string()
    .min(1)
    .describe(
      "Imperative instruction for gemini. Must read as a command (start with an action verb like write/edit/translate/generate/refactor/fix; avoid trailing '?'). Open-ended questions will be rejected."
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Pre-curated material the caller wants gemini to reference (file contents, examples, prior turns). Prepended to the prompt as `[Context]\\n\\n<context>\\n\\n[Task]\\n\\n<task>`."
    ),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Absolute paths under the project root to expose to gemini via --include-directories. Path traversal ('..') and paths outside the project root are refused."
    ),
  model: z
    .enum(["flash", "pro", "auto"])
    .optional()
    .describe(
      "flash → gemini-2.5-flash-lite; pro → gemini-2.5-pro; auto (default) → no -m flag, gemini picks (currently auto-gemini-3)."
    ),
  approval_mode: z
    .enum(["auto_edit", "yolo", "plan"])
    .optional()
    .describe(
      "Maps to gemini's --approval-mode. Defaults to auto_edit."
    ),
  format: z
    .enum(["text", "json"])
    .optional()
    .describe(
      "If 'json', appends a JSON-only suffix to the task and validates the response parses. On parse failure the raw output is returned with a parse_error field."
    ),
};

const outputSchema = {
  output: z.string().describe("Concatenated assistant message content from gemini."),
  exit_code: z.number().describe("gemini process exit code (-1 on spawn failure)."),
  stats: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    ms: z.number(),
  }),
  truncated: z.boolean().optional().describe("True if output was capped at 256 KiB."),
  error: z.string().optional().describe("Set on timeout, cancellation, or non-zero exit."),
  partial_output: z.string().optional().describe("Set alongside `error` for timeout / cancellation."),
  parse_error: z.string().optional().describe("Set when format='json' and the response was not valid JSON."),
  parsed: z.unknown().optional().describe("Parsed JSON value when format='json' succeeds."),
  stderr_tail: z.string().optional().describe("Last 500 chars of gemini's stderr on failure."),
};

/**
 * Register the gemini.execute tool on the broker.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerGeminiExecute(server) {
  server.registerTool(
    "gemini.execute",
    {
      description:
        "Hand a tightly-scoped imperative task to the local gemini CLI and return its final output. " +
        "Use this for translation, code generation, refactoring, and other deterministic write-side work " +
        "where the caller has already done the understanding and just needs gemini to execute. " +
        "task validation: must start with an action verb or contain one of write/edit/translate/generate/produce/convert/rewrite/etc., " +
        "must not end with '?'. Files are restricted to paths under the project root. Hard 5-minute timeout, 256 KiB output cap.",
      inputSchema,
      outputSchema,
    },
    async (input, extra) => {
      const taskCheck = validateImperative(input.task);
      if (!taskCheck.ok) {
        const err = `task must be imperative — ${taskCheck.reason}. Got: ${JSON.stringify(input.task.slice(0, 120))}`;
        return invalidResult(err);
      }

      let resolvedFiles = [];
      if (input.files && input.files.length > 0) {
        const filesCheck = validateFiles(input.files);
        if (!filesCheck.ok) {
          const err = `files validation failed: ${filesCheck.reason}`;
          return invalidResult(err);
        }
        resolvedFiles = filesCheck.abs;
      }

      const res = await runGemini({
        task: input.task,
        context: input.context,
        files: resolvedFiles,
        model: input.model,
        approval_mode: input.approval_mode,
        format: input.format,
        signal: extra?.signal,
      });

      const isError = typeof res.error === "string";
      const summary = isError
        ? `gemini.execute error: ${res.error}\n\n${res.partial_output ?? res.output ?? ""}`
        : res.output;

      return {
        isError,
        content: [{ type: "text", text: summary || "(no output)" }],
        structuredContent: res,
      };
    }
  );
}
