#!/usr/bin/env node
/**
 * spectre-mcp-broker
 *
 * MCP server over stdio. Two tool categories:
 *
 *   1. Write-side host tools (bash, edit, write). Every
 *      call is forwarded to Jerome's permission endpoint, which shows
 *      the human a UI modal and returns a decision. Only after approval
 *      does the broker actually execute the tool.
 *
 *   2. Executor tools (gemini.execute). These are local LLM invocations
 *      with no destructive host side-effects of their own — they hand a
 *      tightly-scoped imperative to the local `gemini` CLI and return
 *      its output. No human-approval gate; the orchestrator that called
 *      gemini.execute owns whatever side effects gemini's output drives.
 *
 * Env vars (passed via --mcp-config when Claude spawns us):
 *   SPECTRE_THREAD_ID    — the thread/session this broker instance is tied to
 *   SPECTRE_APP_URL      — base URL of the Next.js app (default http://127.0.0.1:3000)
 *   SPECTRE_SERVICE_TOKEN — shared secret for broker↔jerome-app auth
 *
 * The broker is spawned once per claude session (see
 * src/lib/ai/providers/claude-code.ts). It does NOT persist state beyond
 * the child-process lifetime — approvals are resolved entirely inside the
 * Next.js process via its own module-level map.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { registerGeminiExecute } from "./gemini-execute.mjs";
import { registerOpenAITools } from "./openai-tools.mjs";
import { registerDispatchToModel } from "./dispatch-tool.mjs";
import { registerDataTools } from "./data-tools.mjs";
import { registerCliDispatchTools } from "./cli-dispatch.mjs";
// Import (not readFileSync) the catalog so `bun build --compile` EMBEDS it in the
// broker binary — a compiled binary has no tools-catalog.json on disk, and reading
// it at runtime crashed the binary on startup. Works in node 24 + bun via the
// import attribute.
import TOOL_CATALOG from "./tools-catalog.json" with { type: "json" };
import { scanCommand } from "./command-scan.mjs";

const THREAD_ID = process.env.SPECTRE_THREAD_ID;
const APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000";
const SERVICE_TOKEN = process.env.SPECTRE_SERVICE_TOKEN;
// The core gates /api/* on CORE_TOKEN; attach it to every call back into Jerome.
const CORE_TOKEN = process.env.CORE_TOKEN;
// Headless self-evolution (workshop) run: auto-approve the write-side tools
// (bash/write/edit). The workshop runs on a dedicated branch and
// its diff is human-reviewed before any push, so the run itself is trusted to
// edit autonomously — exactly the trust model of the CLI's bypassPermissions.
// Only the workshop worker ever sets this; interactive chat never does.
const WORKSHOP = process.env.SPECTRE_WORKSHOP === "1";

if (!THREAD_ID) {
  console.error("[spectre-mcp-broker] SPECTRE_THREAD_ID not set — aborting");
  process.exit(1);
}

/**
 * POST a permission request to Jerome and block until the human decides.
 * Returns { decision: "allow" | "deny" | "allow_session", reason?: string }.
 *
 * FAIL CLOSED: any transport error (ECONNRESET, timeout, DNS failure), any
 * non-OK HTTP status, or any response that isn't valid JSON with a "decision"
 * field resolves to a deny instead of throwing or defaulting to allow. This
 * prevents a core restart from leaving the broker in an indeterminate state.
 */
async function requestApproval(tool, input, { forceInteractive = false } = {}) {
  // Workshop runs are trusted to edit autonomously (branch-isolated, reviewed
  // before push) — skip the human round-trip the same way the CLI's
  // bypassPermissions did. No core call is needed in this mode. Exception:
  // commands the pre-execution scanner FLAGGED always get the human round-trip;
  // headless runs then fail-closed on the approval timeout.
  if (WORKSHOP && !forceInteractive) return { decision: "allow", reason: "workshop autonomous" };

  // Broker-side timeout guard: if the core is restarting or hung, the fetch may
  // never settle. Bound the wait so the broker doesn't block indefinitely.
  // Default: 3 min (matching the core's SPECTRE_APPROVAL_TIMEOUT_MS default).
  const timeoutMs = Number(process.env.SPECTRE_APPROVAL_TIMEOUT_MS ?? 180_000);
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(`${APP_URL}/api/threads/${THREAD_ID}/permission/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SERVICE_TOKEN ? { "X-Spectre-Service-Token": SERVICE_TOKEN } : {}),
        ...(CORE_TOKEN ? { "x-spectre-core-token": CORE_TOKEN } : {}),
      },
      body: JSON.stringify({ tool, input }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Non-OK status (e.g. 401, 500, 503 during restart) — deny immediately.
      const body = await res.text().catch(() => "");
      console.error(`[spectre-mcp-broker] permission gate ${res.status}: ${body.slice(0, 200)}`);
      return { decision: "deny", reason: `permission gate error ${res.status} — fail-closed` };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      console.error("[spectre-mcp-broker] permission gate returned non-JSON — fail-closed");
      return { decision: "deny", reason: "permission gate returned non-JSON — fail-closed" };
    }

    // Sanity-check: response must carry a known decision field.
    if (
      !data ||
      (data.decision !== "allow" && data.decision !== "deny" && data.decision !== "allow_session")
    ) {
      console.error("[spectre-mcp-broker] permission gate returned unknown decision — fail-closed", data);
      return { decision: "deny", reason: "permission gate returned unknown decision — fail-closed" };
    }

    return data;
  } catch (err) {
    // Transport-level failure: ECONNRESET (core restarted), ECONNREFUSED, fetch
    // abort (our own timeout above), or any other network error — deny.
    const reason = err?.name === "AbortError"
      ? "approval timed out broker-side — fail-closed"
      : `transport error (${err?.message ?? String(err)}) — fail-closed`;
    console.error(`[spectre-mcp-broker] requestApproval: ${reason}`);
    return { decision: "deny", reason };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const server = new McpServer(
  { name: "spectre", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Tool catalog is the single source of truth (also read by /api/mcp for the UI).
// TOOL_CATALOG is imported above (embedded into the binary by bun --compile).

server.registerTool(
  "tools.list",
  {
    description:
      "List Spectre's available MCP tools, grouped by category, with purpose and Claude-visible tool names. Use when unsure what Spectre can do.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Optional category filter, e.g. memory, workshop, schedules, generation"),
    },
  },
  async ({ category } = {}) => {
    const items = TOOL_CATALOG
      .filter((t) => !category || t.category === category)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const lines = [];
    let current = "";
    for (const tool of items) {
      if (tool.category !== current) {
        current = tool.category;
        lines.push(`${lines.length ? "\n" : ""}# ${current}`);
      }
      const visible = `mcp__spectre__${tool.name.replaceAll(".", "_")}`;
      lines.push(`- ${tool.name} (${visible}): ${tool.description}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") || "(no matching tools)" }] };
  }
);

/* ─────────────────────────────── bash ─────────────────────────────── */

server.registerTool(
  "bash",
  {
    description:
      "Run a shell command on the host. Approval is requested from the human before execution.",
    inputSchema: {
      command: z.string().describe("The shell command to execute"),
      description: z
        .string()
        .optional()
        .describe("One-line human-readable summary of what the command does"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds (default 120000)"),
    },
  },
  async ({ command, description, timeout }) => {
    const scan = scanCommand(command);
    if (scan.verdict === "block") {
      return {
        isError: true,
        content: [
          { type: "text", text: `Blocked by the pre-execution scanner: ${scan.reason}. This command cannot run through the bash tool, with or without approval.` },
        ],
      };
    }
    const decision =
      scan.verdict === "flag"
        ? await requestApproval("bash", { command, description, risk: scan.reason }, { forceInteractive: true })
        : await requestApproval("bash", { command, description });
    if (decision.decision === "deny") {
      return {
        isError: true,
        content: [
          { type: "text", text: `Denied by user${decision.reason ? `: ${decision.reason}` : ""}` },
        ],
      };
    }
    return runBash(command, timeout ?? 120_000);
  }
);

// Clean, base-only env for the bash tool. The broker process holds CORE_TOKEN +
// SPECTRE_SERVICE_TOKEN (it calls back to the core), but the user's shell command
// must NOT see them — otherwise a prompt-injected agent could `echo $CORE_TOKEN`
// and exfiltrate it. Allowlist the harmless shell/runtime vars only.
const BASH_ENV_ALLOW = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec", "windir", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
];
function bashEnv() {
  const out = {};
  for (const k of BASH_ENV_ALLOW) {
    if (typeof process.env[k] === "string") out[k] = process.env[k];
  }
  return out;
}

function runBash(command, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], env: bashEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += `\n[jerome-broker: command exceeded ${timeoutMs}ms, killed]`;
    }, timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      resolve({
        isError: code !== 0,
        content: [{ type: "text", text: output || `(exit ${code}, no output)` }],
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        isError: true,
        content: [{ type: "text", text: `Failed to spawn bash: ${err.message}` }],
      });
    });
  });
}

/* ─────────────────────────────── write ─────────────────────────────── */

server.registerTool(
  "write",
  {
    description:
      "Write content to an absolute file path. Overwrites existing files. Approval is requested from the human before execution.",
    inputSchema: {
      file_path: z.string().describe("Absolute file path"),
      content: z.string().describe("Full file content"),
    },
  },
  async ({ file_path, content }) => {
    const decision = await requestApproval("write", {
      file_path,
      preview: content.length > 200 ? content.slice(0, 200) + "…" : content,
      size: content.length,
    });
    if (decision.decision === "deny") {
      return {
        isError: true,
        content: [{ type: "text", text: "Denied by user" }],
      };
    }
    try {
      await writeFile(file_path, content, "utf-8");
      return { content: [{ type: "text", text: `Wrote ${content.length} bytes to ${file_path}` }] };
    } catch (err) {
      return toolErr("Write", err);
    }
  }
);

/* ─────────────────────────────── edit ─────────────────────────────── */

server.registerTool(
  "edit",
  {
    description:
      "Replace a unique string in a file. Approval is requested from the human before execution.",
    inputSchema: {
      file_path: z.string().describe("Absolute file path"),
      old_string: z.string().describe("Exact string to replace (must be unique in the file)"),
      new_string: z.string().describe("Replacement string"),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence instead of requiring uniqueness"),
    },
  },
  async ({ file_path, old_string, new_string, replace_all }) => {
    const decision = await requestApproval("edit", {
      file_path,
      old_preview: old_string.slice(0, 200),
      new_preview: new_string.slice(0, 200),
      replace_all: !!replace_all,
    });
    if (decision.decision === "deny") {
      return { isError: true, content: [{ type: "text", text: "Denied by user" }] };
    }
    try {
      const current = await readFile(file_path, "utf-8");
      if (!current.includes(old_string)) {
        return {
          isError: true,
          content: [{ type: "text", text: "old_string not found in file" }],
        };
      }
      if (!replace_all && current.split(old_string).length !== 2) {
        return {
          isError: true,
          content: [{ type: "text", text: "old_string is not unique (pass replace_all=true)" }],
        };
      }
      const next = replace_all
        ? current.split(old_string).join(new_string)
        : current.replace(old_string, new_string);
      await writeFile(file_path, next, "utf-8");
      return {
        content: [{ type: "text", text: `Edited ${file_path} (${current.length} → ${next.length} bytes)` }],
      };
    } catch (err) {
      return toolErr("Edit", err);
    }
  }
);

/* ─────────────────────────── memory tools ──────────────────────────── */

// Like gemini.execute, the memory tools do NOT route through the human-
// approval gate. They're database reads/writes — not host-filesystem ops —
// so gating them behind a modal would be needlessly disruptive (imagine
// a confirmation prompt every time Jerome wants to remember your coffee order).

const authHeaders = (opts) => ({
  "Content-Type": "application/json",
  ...(SERVICE_TOKEN ? { "X-Spectre-Service-Token": SERVICE_TOKEN } : {}),
  ...(CORE_TOKEN ? { "x-spectre-core-token": CORE_TOKEN } : {}),
  ...opts.headers,
});

async function memoryFetch(path, opts = {}) {
  const res = await fetch(`${APP_URL}/api${path}`, {
    ...opts,
    headers: authHeaders(opts),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`memory API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function apiFetch(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...opts,
    headers: authHeaders(opts),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail = data?.error || text || res.statusText;
    throw new Error(`${path} returned ${res.status}: ${detail}`);
  }
  return data;
}

const appFetch = (path, opts) => apiFetch(APP_URL, path, opts);

/** Best-effort chat title for approval prompts + result messages (never throws). */
async function chatTitle(chatId) {
  try {
    const t = await appFetch(`/threads/${encodeURIComponent(chatId)}`);
    return (t && typeof t.title === "string" && t.title.trim()) || "(untitled)";
  } catch {
    return "(unknown chat)";
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function toolText(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

const toolErr = (label, err) => ({ isError: true, content: [{ type: "text", text: `${label} failed: ${err.message}` }] });

async function requireApproval(tool, input) {
  const decision = await requestApproval(tool, input);
  if (decision.decision === "deny") {
    throw new Error(`Denied by user${decision.reason ? `: ${decision.reason}` : ""}`);
  }
  return decision;
}

/* ───────────────────────── autonomy quota gate ─────────────────────── */
//
// During a bounded PROACTIVE run the brain has a read-mostly whitelist of
// tools (memory/notify/calendar/analytics/schedule-read). Those tools are
// pre-seeded with always_allow thread policies carrying a per-tool hourly
// quota (see src/lib/ai/proactive.ts → persistProactivePolicy). To make the
// quota actually enforce + log to tool_calls, each whitelisted handler routes
// through the SAME permission endpoint the write-side tools use, but only when
// SPECTRE_AUTONOMOUS=1. In normal interactive chat this flag is unset, so the
// gate is a no-op (returns true immediately) and the tools stay byte-for-byte
// unchanged: no prompt, no quota, no log.
//
// CRITICAL: the pre-seeded policies are keyed by the VISIBLE tool name
// (e.g. mcp__spectre__memory_search), so each handler MUST pass its visible
// name here — never the dot form — or lookupPolicy/recentCallCount won't match.
const AUTONOMOUS = process.env.SPECTRE_AUTONOMOUS === "1";
const AUTONOMOUS_THREAD = process.env.SPECTRE_AUTONOMOUS_THREAD || THREAD_ID;

/**
 * Permission gate for the read-mostly autonomy whitelist. Returns `true` to
 * proceed (the no-op interactive path, plus any allow/fail-open outcome), or a
 * tool-error result object (the same shape the handlers return on error) when
 * the pre-seeded quota has been exhausted and the policy denies the call.
 * FAIL-OPEN: any transport/HTTP failure returns true — the gate must never be
 * the thing that breaks a tool.
 */
async function autonomyGate(policyTool) {
  if (!AUTONOMOUS) return true;
  let decision;
  try {
    const res = await fetch(
      `${APP_URL}/api/threads/${AUTONOMOUS_THREAD}/permission/request`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(SERVICE_TOKEN ? { "X-Spectre-Service-Token": SERVICE_TOKEN } : {}),
          ...(CORE_TOKEN ? { "x-spectre-core-token": CORE_TOKEN } : {}),
        },
        body: JSON.stringify({ tool: policyTool, input: { autonomous: true } }),
      },
    );
    if (!res.ok) return true;
    decision = await res.json();
  } catch {
    return true;
  }
  if (decision && decision.decision === "deny") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Autonomy limit: ${policyTool} ${decision.reason || "denied"}`,
        },
      ],
    };
  }
  return true;
}

server.registerTool(
  "memory.add",
  {
    description:
      "Save a fact to Spectre's long-term memory. Use for information that should persist across conversations — user preferences, project decisions, explicit 'remember this' requests. NOT for notes/ideas/todos — use note.add or todo.add for those (memory and notes are different concepts: memory = facts Spectre should recall, notes = thoughts/ideas the user dictates).",
    inputSchema: {
      content: z.string().describe("The fact to remember"),
      category: z
        .enum(["user", "project", "preference", "work", "note"])
        .optional()
        .describe("Memory category (default: note)"),
      importance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Importance 1–10, where 10 is critical (default: 5)"),
    },
  },
  async ({ content, category, importance }) => {
    const gate = await autonomyGate("mcp__spectre__memory_add"); if (gate !== true) return gate;
    try {
      const data = await memoryFetch("/memory", {
        method: "POST",
        body: JSON.stringify({
          content,
          category: category ?? "note",
          importance: importance ?? 5,
        }),
      });
      const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
      return {
        content: [{ type: "text", text: `Saved memory ${data.id}: "${preview}"` }],
      };
    } catch (err) {
      return toolErr("memory.add", err);
    }
  }
);

server.registerTool(
  "memory.search",
  {
    description:
      "Search Spectre's long-term memory for relevant facts. Use at the start of conversations where past context would help, or when the user references something Spectre might have noted before.",
    inputSchema: {
      q: z
        .string()
        .optional()
        .describe("Substring search string (matches content). Omit to list all."),
      category: z
        .enum(["user", "project", "preference", "work", "note"])
        .optional()
        .describe("Filter by category"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum results (default: 20)"),
    },
  },
  async ({ q, category, limit }) => {
    const gate = await autonomyGate("mcp__spectre__memory_search"); if (gate !== true) return gate;
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (category) params.set("category", category);
      params.set("limit", String(limit ?? 20));

      const data = await memoryFetch(`/memory?${params}`);
      const items = data.items ?? [];

      if (items.length === 0) {
        return { content: [{ type: "text", text: "(no matching memories)" }] };
      }

      const text = items
        .map(
          (m) =>
            `[${m.id}] cat=${m.category} imp=${m.importance} | ${m.content}`
        )
        .join("\n");

      return { content: [{ type: "text", text: text }] };
    } catch (err) {
      return toolErr("memory.search", err);
    }
  }
);

server.registerTool(
  "memory.delete",
  {
    description:
      "Delete a stale or incorrect memory by its UUID. Use only when a memory is wrong or clearly outdated — prefer updating via memory.add with corrected content.",
    inputSchema: {
      id: z.string().describe("The memory entry UUID (from memory.search results)"),
    },
  },
  async ({ id }) => {
    try {
      await memoryFetch(`/memory/${id}`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Deleted memory ${id}` }] };
    } catch (err) {
      return toolErr("memory.delete", err);
    }
  }
);

/* ───────────────────── notes & todos ──────────────────────────────── */
//
// Notes are user-drafted thoughts the user dictates ("write that down —
// good idea"). Todos are structured tasks with optional deadline +
// priority. Both live in the `notes` table; UI surfaces them in
// /memory under the Notes tab.
//
// CRITICAL: this is NOT memory.add. Memory holds long-term FACTS about
// the user / projects (preferences, decisions). Notes are thoughts +
// ideas + tasks. Different concepts, different storage, different tool.

server.registerTool(
  "note.add",
  {
    description:
      "Save a free-form note — a thought, idea, or observation the user dictated. Use when the user says 'write that down', 'note this', 'good idea — save it', or when you have a useful idea mid-conversation that's worth keeping. Returns the saved note id.",
    inputSchema: {
      content: z.string().describe("The note content — a sentence or paragraph"),
      pinned: z.boolean().optional().describe("Pin to the top of the notes list (default false)"),
    },
  },
  async ({ content, pinned }) => {
    try {
      const data = await memoryFetch("/notes", {
        method: "POST",
        body: JSON.stringify({ kind: "note", content, pinned: pinned === true }),
      });
      const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
      return { content: [{ type: "text", text: `Saved note ${data.id}: "${preview}"` }] };
    } catch (err) {
      return toolErr("note.add", err);
    }
  },
);

server.registerTool(
  "todo.add",
  {
    description:
      "Save a structured todo — a task with optional deadline and priority. Use when the user says 'add a todo', 'remind me to', 'I need to', 'TODO:' or similar action-flavoured language. Distinct from note.add (which is free-form thoughts).",
    inputSchema: {
      content: z.string().describe("What to do — short imperative phrasing"),
      deadline: z
        .string()
        .optional()
        .describe("Optional deadline as ISO 8601 (e.g. 2026-05-10T17:00:00Z) or any Date-parseable string"),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Optional priority (default unset)"),
    },
  },
  async ({ content, deadline, priority }) => {
    try {
      const data = await memoryFetch("/notes", {
        method: "POST",
        body: JSON.stringify({ kind: "todo", content, deadline, priority }),
      });
      const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
      const tag = priority ? ` [${priority}]` : "";
      const due = deadline ? ` due ${deadline}` : "";
      return { content: [{ type: "text", text: `Saved todo ${data.id}${tag}${due}: "${preview}"` }] };
    } catch (err) {
      return toolErr("todo.add", err);
    }
  },
);

server.registerTool(
  "note.list",
  {
    description:
      "List the user's notes and/or todos. Use when they ask about saved notes ('what did I write down', 'open todos', 'pending ideas') or before starting work that might already have a note attached.",
    inputSchema: {
      kind: z.enum(["note", "todo"]).optional().describe("Filter by kind (default: both)"),
      q: z.string().optional().describe("Substring search on content"),
      open_only: z
        .boolean()
        .optional()
        .describe("For todos: hide completed ones (default: false → show all)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 30)"),
    },
  },
  async ({ kind, q, open_only, limit }) => {
    try {
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (q) params.set("q", q);
      if (open_only === true) params.set("done", "0");
      params.set("limit", String(limit ?? 30));
      const data = await memoryFetch(`/notes?${params}`);
      const items = data.items ?? [];
      if (items.length === 0) return { content: [{ type: "text", text: "(no matching notes)" }] };
      const lines = items.map((n) => {
        const flag = n.kind === "todo" ? (n.done ? "✓" : "•") : "📝";
        const tag = n.priority ? ` [${n.priority}]` : "";
        const due = n.deadline ? ` due ${n.deadline}` : "";
        return `${flag} [${n.id}] ${n.kind}${tag}${due}: ${n.content}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return toolErr("note.list", err);
    }
  },
);

server.registerTool(
  "todo.complete",
  {
    description: "Mark a todo as done. Use when the user says they finished one, or when a task you tracked just shipped.",
    inputSchema: {
      id: z.string().describe("The todo's UUID"),
    },
  },
  async ({ id }) => {
    try {
      const data = await memoryFetch(`/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ done: true }),
      });
      const preview = (data.content || "").slice(0, 80);
      return { content: [{ type: "text", text: `Marked todo ${id} done: "${preview}"` }] };
    } catch (err) {
      return toolErr("todo.complete", err);
    }
  },
);

server.registerTool(
  "note.delete",
  {
    description: "Permanently delete a note or todo by id. Use sparingly — todo.complete is the right move for finished tasks.",
    inputSchema: { id: z.string().describe("The note/todo UUID") },
  },
  async ({ id }) => {
    try {
      await memoryFetch(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Deleted ${id}` }] };
    } catch (err) {
      return toolErr("note.delete", err);
    }
  },
);

/* ──────────────────────────── notify ──────────────────────────────── */

// Push a notification to Jerome's registered devices. No approval gate —
// sending a notification is not a destructive host-side effect.
server.registerTool(
  "notify",
  {
    description:
      "Send a push notification to Spectre's registered devices. Use when a long background task finishes or when something important needs immediate attention.",
    inputSchema: {
      title: z.string().describe("Short notification title (≤ 50 chars)"),
      body: z.string().describe("Notification body text (≤ 120 chars)"),
      url: z.string().optional().describe("URL to open when the notification is tapped (default: /chat)"),
    },
  },
  async ({ title, body, url }) => {
    const gate = await autonomyGate("mcp__spectre__notify"); if (gate !== true) return gate;
    try {
      await memoryFetch("/push/send", {
        method: "POST",
        body: JSON.stringify({ title, body, url }),
      });
      return { content: [{ type: "text", text: `Notification sent: "${title}"` }] };
    } catch (err) {
      return toolErr("notify", err);
    }
  }
);

/* ──────────────────────────── calendar ────────────────────────────── */

server.registerTool(
  "calendar.today",
  {
    description:
      "Return today's calendar events, merged across ALL connected Microsoft 365 accounts. Returns an error if no MS 365 account is connected.",
    inputSchema: {},
  },
  async () => {
    const gate = await autonomyGate("mcp__spectre__calendar_today"); if (gate !== true) return gate;
    try {
      const data = await memoryFetch("/calendar/events");
      const events = data?.events ?? [];
      if (events.length === 0) {
        return { content: [{ type: "text", text: "No events today." }] };
      }
      const multi = (data?.accounts?.length ?? 0) > 1;
      const lines = events.map((e) => {
        const start = e.isAllDay ? "all day" : new Date(e.start.dateTime).toLocaleTimeString("en-AT", { hour: "2-digit", minute: "2-digit" });
        const end = e.isAllDay ? "" : `–${new Date(e.end.dateTime).toLocaleTimeString("en-AT", { hour: "2-digit", minute: "2-digit" })}`;
        const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
        const who = multi && e.account ? `  ·  ${e.account}` : "";
        return `• ${start}${end}${loc}  ${e.subject}${who}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return toolErr("calendar.today", err);
    }
  }
);

server.registerTool(
  "calendar.upcoming",
  {
    description:
      "Return upcoming calendar events for the next N days (default 7), merged across ALL connected Microsoft 365 accounts.",
    inputSchema: {
      days: z.number().int().min(1).max(30).optional().describe("Number of days to look ahead (default: 7)"),
    },
  },
  async ({ days = 7 }) => {
    const gate = await autonomyGate("mcp__spectre__calendar_upcoming"); if (gate !== true) return gate;
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + days);
      const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
      const data = await memoryFetch(`/calendar/events?${params}`);
      const events = data?.events ?? [];
      if (events.length === 0) {
        return { content: [{ type: "text", text: `No events in the next ${days} day${days === 1 ? "" : "s"}.` }] };
      }
      const multi = (data?.accounts?.length ?? 0) > 1;
      const lines = events.map((e) => {
        const date = new Date(e.start.dateTime).toLocaleDateString("en-AT", { weekday: "short", month: "short", day: "numeric" });
        const time = e.isAllDay ? "all day" : new Date(e.start.dateTime).toLocaleTimeString("en-AT", { hour: "2-digit", minute: "2-digit" });
        const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
        const who = multi && e.account ? `  ·  ${e.account}` : "";
        return `• ${date} ${time}${loc}  ${e.subject}${who}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return toolErr("calendar.upcoming", err);
    }
  }
);

/* ────────────────────────────── mail ──────────────────────────────── */

server.registerTool(
  "mail.list",
  {
    description:
      "List recent emails — or search with a query — across ALL connected Microsoft 365 + Google accounts (read-only, live, nothing stored). Each result shows from / subject / snippet plus an [account_id … id …] handle; pass those to mail.read to read the full message. Errors if no mail account is connected.",
    inputSchema: {
      query: z.string().optional().describe("search text (e.g. 'from:boss invoice'); omit for the most recent"),
      count: z.number().int().min(1).max(25).optional().describe("max messages (default 10)"),
    },
  },
  async ({ query = "", count = 10 }) => {
    const gate = await autonomyGate("mcp__spectre__mail_list"); if (gate !== true) return gate;
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      params.set("count", String(count));
      const data = await memoryFetch(`/mail/messages?${params}`);
      const msgs = data?.messages ?? [];
      if (msgs.length === 0) {
        return { content: [{ type: "text", text: query ? "No matching emails." : "No recent emails." }] };
      }
      const multi = (data?.accounts?.length ?? 0) > 1;
      const lines = msgs.map((m) => {
        const date = m.date ? new Date(m.date).toLocaleString("en-AT", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        const who = multi ? `  ·  ${m.account}` : "";
        const unread = m.isRead ? "  " : "• ";
        return `${unread}${date}  ${m.from}${who}\n   ${m.subject}\n   ${m.snippet}\n   [account_id:${m.account_id} id:${m.id}]`;
      });
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err) {
      return toolErr("mail.list", err);
    }
  }
);

server.registerTool(
  "mail.read",
  {
    description:
      "Read one full email by account_id + id (both taken from a mail.list result). Returns the plain-text body with From/To/Date/Subject.",
    inputSchema: {
      account_id: z.string().describe("the account_id from mail.list"),
      id: z.string().describe("the message id from mail.list"),
    },
  },
  async ({ account_id, id }) => {
    const gate = await autonomyGate("mcp__spectre__mail_read"); if (gate !== true) return gate;
    try {
      const params = new URLSearchParams({ account_id, id });
      const m = await memoryFetch(`/mail/message?${params}`);
      const text = `From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`;
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toolErr("mail.read", err);
    }
  }
);

/* ─────────────────────────────── setup ────────────────────────────── */
// Connector/integration setup helpers — let Spectre guide + do parts of setup in
// chat. Writes go through requireApproval so the user confirms before anything is
// saved. See the 'connector-setup' skill for how to use these.

server.registerTool(
  "setup.status",
  {
    description:
      "Show which integrations are connected (Microsoft, Google, GitHub, channels, web push, workspace, model gateway, database) and which CLI brains are installed. Call this first when helping the user set something up.",
    inputSchema: {},
  },
  async () => {
    const gate = await autonomyGate("mcp__spectre__setup_status"); if (gate !== true) return gate;
    try {
      const data = await appFetch("/connectors");
      const icon = (s) => (s === "connected" ? "✓" : s === "off" ? "✗" : s === "error" ? "!" : "…");
      const lines = (data?.connectors ?? []).map((c) => `${icon(c.status)} ${c.name}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") || "No connectors reported." }] };
    } catch (err) {
      return toolErr("setup.status", err);
    }
  }
);

server.registerTool(
  "setup.add_cli",
  {
    description:
      "Register any command-line tool as a pickable model brain (e.g. grok, qwen, a local script), so the user isn't limited to the built-in Claude/Codex/Gemini. The binary must already exist in the core container. Args may use {model}. Confirm the command with the user first.",
    inputSchema: {
      name: z.string().describe("display name, e.g. 'Grok'"),
      command: z.string().describe("the command to run, e.g. 'grok'"),
      args: z.string().optional().describe("space-separated args, e.g. 'exec --model {model}'"),
      env_name: z.string().optional().describe("auth env var name, e.g. XAI_API_KEY"),
      env_value: z.string().optional().describe("auth env var value"),
    },
  },
  async ({ name, command, args, env_name, env_value }) => {
    const gate = await autonomyGate("mcp__spectre__setup_add_cli"); if (gate !== true) return gate;
    await requireApproval("mcp__spectre__setup_add_cli", { name, command, args });
    try {
      const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom") + "-cli";
      const body = {
        schemaVersion: 1, id, label: name, kind: "cli-command",
        command, args: args && args.trim() ? args.trim().split(/\s+/) : [],
        promptMode: "stdin", outputMode: "stdout", roles: { brain: true, dispatch: true },
      };
      if (env_name && env_value) body.env = { [env_name]: env_value };
      await appFetch("/providers/backends", { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text", text: `Added "${name}" (id ${id}) as a brain — it's now in the model picker. Reminder: its binary must be installed in the core container.` }] };
    } catch (err) {
      return toolErr("setup.add_cli", err);
    }
  }
);

server.registerTool(
  "setup.save_secret",
  {
    description:
      "Save a credential the user gives you into the right connector. Use for: github_token; cli_token (also pass cli_id: claude-code | codex-cli | gemini-cli); telegram_bot_token; whatsapp_token; discord_bot_token. For Microsoft/Google OAuth, guide the user to Settings instead (those aren't plain tokens). The user is asked to confirm before it saves.",
    inputSchema: {
      target: z.enum(["github_token", "cli_token", "telegram_bot_token", "whatsapp_token", "discord_bot_token"]),
      value: z.string().describe("the secret/token value"),
      cli_id: z.enum(["claude-code", "codex-cli", "gemini-cli"]).optional().describe("required when target is cli_token"),
    },
  },
  async ({ target, value, cli_id }) => {
    const gate = await autonomyGate("mcp__spectre__setup_save_secret"); if (gate !== true) return gate;
    await requireApproval("mcp__spectre__setup_save_secret", { target, cli_id });
    try {
      if (target === "github_token") {
        await appFetch("/providers/github/token", { method: "PUT", body: JSON.stringify({ token: value }) });
      } else if (target === "cli_token") {
        if (!cli_id) throw new Error("cli_id is required for cli_token");
        await appFetch("/providers/cli/token", { method: "PUT", body: JSON.stringify({ id: cli_id, token: value }) });
      } else if (target === "telegram_bot_token") {
        await appFetch("/providers/channels", { method: "PUT", body: JSON.stringify({ telegram: { botToken: value } }) });
      } else if (target === "whatsapp_token") {
        await appFetch("/providers/channels", { method: "PUT", body: JSON.stringify({ whatsapp: { token: value } }) });
      } else if (target === "discord_bot_token") {
        await appFetch("/providers/channels", { method: "PUT", body: JSON.stringify({ discord: { botToken: value } }) });
      }
      return { content: [{ type: "text", text: `Saved ${target}${cli_id ? ` (${cli_id})` : ""}. ✓ Call setup.status to confirm.` }] };
    } catch (err) {
      return toolErr("setup.save_secret", err);
    }
  }
);

/* ──────────────────────────── analytics ───────────────────────────── */

server.registerTool(
  "analytics.usage",
  {
    description:
      "Return Spectre's token usage and cost breakdown for a given time window. Use to answer questions like 'how much have I spent today?' or 'which model did I use most?'",
    inputSchema: {
      windowHours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .describe("Look-back window in hours (default: 24, max: 168 / 7 days)"),
    },
  },
  async ({ windowHours = 24 } = {}) => {
    const gate = await autonomyGate("mcp__spectre__analytics_usage"); if (gate !== true) return gate;
    try {
      const params = new URLSearchParams({ windowHours: String(windowHours) });
      const data = await memoryFetch(`/usage?${params}`);

      const { totals, items } = data;
      const lines = [
        `Usage – last ${windowHours}h`,
        `  ${totals.messages} messages · ${totals.tokens.toLocaleString()} tokens · ~$${totals.estimatedUsd.toFixed(4)}`,
        `  by mode: api=${totals.byMode.api} subscription=${totals.byMode.subscription} local=${totals.byMode.local}`,
        "",
        "Per model:",
      ];
      for (const item of items) {
        const latency = item.avgLatencyMs ? ` avg ${Math.round(item.avgLatencyMs)}ms` : "";
        lines.push(
          `  ${item.model} [${item.mode}] — ${item.messages} msgs · ${item.tokens.toLocaleString()} tok · ~$${item.estimatedUsd.toFixed(4)}${latency}`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return toolErr("analytics.usage", err);
    }
  }
);

/* ───────────────────────── questionnaire ──────────────────────────── */

const questionnaireFieldSchema = z.object({
  id: z.string().describe("Stable answer key, e.g. scope or risk_level"),
  label: z.string().describe("Question label shown to the user"),
  type: z
    .enum(["text", "textarea", "select", "radio", "checkbox", "boolean"])
    .optional()
    .describe("Input control type; default text"),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  options: z
    .array(
      z.union([
        z.string(),
        z.object({ value: z.string(), label: z.string() }),
      ])
    )
    .optional()
    .describe("Options for select/radio/checkbox fields"),
});

server.registerTool(
  "questionnaire.ask",
  {
    description:
      "Ask the user a structured, embedded questionnaire in the chat UI and wait for typed answers. Use this before planning/executing ambiguous work, like Claude Code plan mode but native to Spectre.",
    inputSchema: {
      title: z.string().describe("Short title for the questionnaire"),
      description: z.string().optional().describe("Context shown above the fields"),
      submitLabel: z.string().optional().describe("Submit button label"),
      questions: z.array(questionnaireFieldSchema).min(1).max(8),
    },
  },
  async (input) => {
    try {
      const decision = await requestApproval("questionnaire", input);
      if (decision.decision === "deny") {
        return {
          isError: true,
          content: [{ type: "text", text: `Questionnaire cancelled${decision.reason ? `: ${decision.reason}` : ""}` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Questionnaire answers:\n${toolText(decision.answer ?? {})}`,
          },
        ],
      };
    } catch (err) {
      return toolErr("questionnaire.ask", err);
    }
  }
);

/* ─────────────────────────── schedules ────────────────────────────── */

const scheduleSchema = {
  name: z.string(),
  prompt: z.string(),
  description: z.string().optional(),
  schedule_type: z.enum(["once", "interval", "daily"]),
  interval_seconds: z.number().int().min(60).optional(),
  run_at: z.string().optional().describe("ISO timestamp for once schedules"),
  time_of_day: z.string().optional().describe("HH:MM for daily schedules"),
  timezone: z.string().optional().describe("IANA timezone, default UTC"),
  target_type: z.enum(["chat", "workshop", "notify"]).optional(),
  model_hint: z.string().optional(),
  thread_id: z.string().optional(),
};

server.registerTool(
  "schedule.create",
  {
    description:
      "Create a durable Spectre schedule. This survives closed chat sessions and is executed by spectre-scheduler.service.",
    inputSchema: scheduleSchema,
  },
  async (input) => {
    try {
      await requireApproval("schedule.create", input);
      const data = await appFetch("/schedules", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return { content: [{ type: "text", text: `Created schedule:\n${toolText(data)}` }] };
    } catch (err) {
      return toolErr("schedule.create", err);
    }
  }
);

server.registerTool(
  "schedule.list",
  {
    description: "List durable Spectre schedules and recent run metadata.",
    inputSchema: {},
  },
  async () => {
    const gate = await autonomyGate("mcp__spectre__schedule_list"); if (gate !== true) return gate;
    try {
      const data = await appFetch("/schedules");
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("schedule.list", err);
    }
  }
);

server.registerTool(
  "schedule.get",
  {
    description: "Get one durable Spectre schedule and run history by id.",
    inputSchema: { scheduleId: z.string() },
  },
  async ({ scheduleId }) => {
    const gate = await autonomyGate("mcp__spectre__schedule_get"); if (gate !== true) return gate;
    try {
      const data = await appFetch(`/schedules/${encodeURIComponent(scheduleId)}`);
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("schedule.get", err);
    }
  }
);

server.registerTool(
  "schedule.update",
  {
    description: "Update a durable Spectre schedule. Asks the user for approval first.",
    inputSchema: {
      scheduleId: z.string(),
      patch: z.record(z.unknown()),
      reason: z.string().optional(),
    },
  },
  async ({ scheduleId, patch, reason }) => {
    try {
      await requireApproval("schedule.update", { scheduleId, patch, reason });
      const data = await appFetch(`/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("schedule.update", err);
    }
  }
);

server.registerTool(
  "schedule.run_now",
  {
    description: "Make a durable Spectre schedule due immediately. The scheduler worker will pick it up.",
    inputSchema: { scheduleId: z.string(), reason: z.string().optional() },
  },
  async ({ scheduleId, reason }) => {
    try {
      await requireApproval("schedule.run_now", { scheduleId, reason });
      const data = await appFetch(`/schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: "POST" });
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("schedule.run_now", err);
    }
  }
);

server.registerTool(
  "schedule.delete",
  {
    description: "Delete a durable Spectre schedule. Asks the user for approval first.",
    inputSchema: { scheduleId: z.string(), reason: z.string().optional() },
  },
  async ({ scheduleId, reason }) => {
    try {
      await requireApproval("schedule.delete", { scheduleId, reason });
      const data = await appFetch(`/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("schedule.delete", err);
    }
  }
);

/* ─────────────────────── chat categories + chats ────────────────────────
   Spectre can see and organize its own chats. A "category" is a bucket a user
   (or Spectre) sorts chats into; a chat's category IS its project_id, and
   "Uncategorized" means it has none. Reads are open; every mutation goes through
   requireApproval, so interactively the user confirms, and an autonomous run
   must carry a pre-seeded always_allow policy (same mechanism as the proactive
   whitelist) before it can act. This is the surface a future background task
   uses to, e.g., distill + delete every chat filed under a "Done"/"Trash"
   category, or to auto-file chats into categories by their description. */

server.registerTool(
  "categories.list",
  {
    description:
      "List chat categories (id, name, description, color). A category groups chats; a chat's category is its project_id. 'Uncategorized' = no category. The description says what belongs in the category.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await appFetch("/projects");
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("categories.list", err);
    }
  }
);

server.registerTool(
  "categories.create",
  {
    description:
      "Create a chat category. `description` is what belongs in it (Spectre uses it to decide which chats to file here); `color` is an optional hex like '#6366f1'. Asks the user for approval first.",
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      color: z.string().optional(),
    },
  },
  async (input) => {
    try {
      await requireApproval("categories.create", input);
      const data = await appFetch("/projects", { method: "POST", body: JSON.stringify(input) });
      return { content: [{ type: "text", text: `Created category:\n${toolText(data)}` }] };
    } catch (err) {
      return toolErr("categories.create", err);
    }
  }
);

server.registerTool(
  "categories.update",
  {
    description: "Update a chat category's name, description, and/or color by id. Asks the user for approval first.",
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      color: z.string().optional(),
    },
  },
  async ({ id, ...patch }) => {
    try {
      await requireApproval("categories.update", { id, patch });
      const data = await appFetch(`/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("categories.update", err);
    }
  }
);

server.registerTool(
  "categories.delete",
  {
    description:
      "Delete a chat category by id. Chats filed under it are NOT deleted — they fall back to Uncategorized. Asks the user for approval first.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  },
  async ({ id, reason }) => {
    try {
      await requireApproval("categories.delete", { id, reason });
      const data = await appFetch(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      return { content: [{ type: "text", text: toolText(data) }] };
    } catch (err) {
      return toolErr("categories.delete", err);
    }
  }
);

server.registerTool(
  "chats.list",
  {
    description:
      "List chats (conversations). Optionally filter by category: pass a category id in `category_id`, or 'none' for Uncategorized. `archived` is 'false' (default), 'true', or 'all'. Returns id, title, category_id, archived, updated_at.",
    inputSchema: {
      category_id: z.string().optional(),
      archived: z.enum(["false", "true", "all"]).optional(),
    },
  },
  async ({ category_id, archived }) => {
    try {
      const qs = new URLSearchParams();
      if (category_id) qs.set("project_id", category_id);
      if (archived) qs.set("archived", archived);
      const q = qs.toString();
      const rows = await appFetch(`/threads${q ? `?${q}` : ""}`);
      const compact = (Array.isArray(rows) ? rows : []).map((t) => ({
        id: t.id,
        title: t.title,
        category_id: t.project_id ?? null,
        archived: !!t.archived,
        updated_at: t.updated_at,
      }));
      return { content: [{ type: "text", text: toolText(compact) }] };
    } catch (err) {
      return toolErr("chats.list", err);
    }
  }
);

server.registerTool(
  "chats.move",
  {
    description:
      "Move a chat into a category, or out of one. Pass the target category id in `category_id`, or 'none' to make it Uncategorized. Asks the user for approval first.",
    inputSchema: { chat_id: z.string(), category_id: z.string() },
  },
  async ({ chat_id, category_id }) => {
    try {
      const title = await chatTitle(chat_id);
      await requireApproval("chats.move", { chat_id, title, category_id });
      const project_id = category_id === "none" ? null : category_id;
      await appFetch(`/threads/${encodeURIComponent(chat_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ project_id }),
      });
      return { content: [{ type: "text", text: `Moved chat "${title}" (${chat_id}) → ${project_id ?? "Uncategorized"}.` }] };
    } catch (err) {
      return toolErr("chats.move", err);
    }
  }
);

server.registerTool(
  "chats.distill",
  {
    description:
      "Distill one chat into long-term memory, then PERMANENTLY DELETE the chat thread. Irreversible — the conversation is replaced by the extracted memories. Asks the user for approval first. This is the per-chat primitive a 'distill + delete everything in category X' cleanup calls.",
    inputSchema: { chat_id: z.string(), reason: z.string().optional() },
  },
  async ({ chat_id, reason }) => {
    try {
      // Resolve the title FIRST so the approval prompt shows which conversation
      // is about to be permanently deleted — an opaque UUID can't be verified.
      const title = await chatTitle(chat_id);
      await requireApproval("chats.distill", { chat_id, title, reason });
      const data = await appFetch(`/threads/${encodeURIComponent(chat_id)}/distill`, { method: "POST" });
      return { content: [{ type: "text", text: `Distilled + deleted chat "${title}" (${chat_id}):\n${toolText(data)}` }] };
    } catch (err) {
      return toolErr("chats.distill", err);
    }
  }
);

/* ───────────────────────────── tempus ─────────────────────────────── */

// Tempus data lives in the core's Supabase-backed API at /api/tempus. Reach it
// the same way memoryFetch/appFetch do — via APP_URL (the core, :8787) with
// authHeaders (X-Spectre-Service-Token + x-spectre-core-token). The old
// hardcoded :3000 was a monolith leftover: the broker runs inside the core
// container, nothing listens on :3000 there, and /api/* is CORE_TOKEN-gated —
// so every tempus tool failed with ECONNREFUSED (or a 401 at the right port).
const TEMPUS_API_URL = `${APP_URL}/api/tempus`;

async function tempusFetch(path, opts = {}) {
  const res = await fetch(`${TEMPUS_API_URL}${path}`, {
    ...opts,
    headers: authHeaders(opts),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const detail = data?.message || data?.error || text || res.statusText;
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return data;
}

function tempusToolError(name, err) {
  return {
    isError: true,
    content: [{ type: "text", text: `${name} failed: ${err.message}` }],
  };
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round((ms ?? 0) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function formatDateTime(value) {
  if (!value) return "unknown time";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-AT", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayBounds(dateInput) {
  const raw = dateInput || localDateString();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${raw}`);
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { label: localDateString(start), start, end };
}

function normalizeRangeStart(value) {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid from date: ${value}`);
  return d;
}

function normalizeRangeEnd(value) {
  if (!value) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid to date: ${value}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) d.setDate(d.getDate() + 1);
  return d;
}

function weekBounds(weekInput) {
  let date;
  let label;
  const isoWeek = /^(\d{4})-W(\d{2})$/.exec(weekInput || "");
  if (isoWeek) {
    const year = Number(isoWeek[1]);
    const week = Number(isoWeek[2]);
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    date = new Date(jan4);
    date.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7);
    label = `${year}-W${String(week).padStart(2, "0")}`;
  } else {
    date = weekInput ? new Date(weekInput) : new Date();
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid week: ${weekInput}`);
  }
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { label: label || `week of ${localDateString(start)}`, start, end };
}

function entrySummaryLine(entry) {
  const project = entry.project?.name || entry.project_name || entry.projectName || entry.project_id || "unknown project";
  const description = entry.description ? ` - ${entry.description}` : "";
  return `- ${formatDuration(entry.duration_ms)} on ${project}${description} (${formatDateTime(entry.start_time)})`;
}

function summarizeEntries(entries, emptyText) {
  if (!entries.length) return emptyText;
  const totalMs = entries.reduce((sum, entry) => sum + (entry.duration_ms || 0), 0);
  const lines = [`${entries.length} entries, ${formatDuration(totalMs)} total:`];
  for (const entry of entries.slice(0, 12)) lines.push(entrySummaryLine(entry));
  if (entries.length > 12) lines.push(`...and ${entries.length - 12} more.`);
  return lines.join("\n");
}

function summarizeReport(label, data) {
  const total = formatDuration(data?.total_ms || 0);
  const count = data?.entry_count || data?.count || 0;
  const projects = data?.projects || data?.by_project || [];
  const entries = data?.entries || [];
  if (!count) return `No Tempus time tracked for ${label}.`;
  const lines = [`Tempus report for ${label}: ${total} across ${count} entries and ${data.project_count || projects.length} projects.`];
  const totals = new Map();
  for (const entry of entries) {
    const key = entry.project?.name || entry.project_id || "unknown project";
    totals.set(key, (totals.get(key) || 0) + (entry.duration_ms || 0));
  }
  for (const project of projects) {
    const key = project.project_name || project.project?.name || project.name || project.project_id || "unknown project";
    totals.set(key, (totals.get(key) || 0) + (project.total_ms || 0));
  }
  for (const [name, ms] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    lines.push(`- ${name}: ${formatDuration(ms)}`);
  }
  return lines.join("\n");
}

server.registerTool(
  "tempus.timer.status",
  {
    description: "Show the currently running Tempus timer, if any.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await tempusFetch("/timer");
      if (!data || data.active === false) return { content: [{ type: "text", text: "No Tempus timer is running." }] };
      const elapsedMs = data.elapsed_ms ?? Math.max(0, Date.now() - new Date(data.start_time).getTime() - Number(data.paused_ms || 0));
      const project = data.project?.name || data.project_id || "unknown project";
      const paused = data.is_paused ? " (paused)" : "";
      const description = data.description ? `: ${data.description}` : "";
      return {
        content: [{ type: "text", text: `Tempus is tracking ${formatDuration(elapsedMs)} on ${project}${description}, started ${formatDateTime(data.start_time)}${paused}.` }],
      };
    } catch (err) {
      return tempusToolError("tempus.timer.status", err);
    }
  }
);

server.registerTool(
  "tempus.timer.start",
  {
    description: "Start a Tempus timer for a project with an optional description.",
    inputSchema: {
      projectId: z.string().min(1).describe("Tempus project id"),
      description: z.string().optional().describe("Optional work description"),
    },
  },
  async ({ projectId, description }) => {
    try {
      await requireApproval("tempus.timer.start", { projectId, description });
      const data = await tempusFetch("/timer/start", {
        method: "POST",
        body: JSON.stringify({ projectId, description }),
      });
      const project = data.project?.name || data.project_id || projectId;
      const suffix = data.description ? `: ${data.description}` : "";
      return { content: [{ type: "text", text: `Started Tempus timer on ${project}${suffix}.` }] };
    } catch (err) {
      return tempusToolError("tempus.timer.start", err);
    }
  }
);

server.registerTool(
  "tempus.timer.stop",
  {
    description: "Stop the active Tempus timer and save the resulting time entry.",
    inputSchema: {},
  },
  async () => {
    try {
      await requireApproval("tempus.timer.stop", {});
      const stopResult = await tempusFetch("/timer/stop", { method: "POST" });
      const data = stopResult?.entry ?? stopResult;
      if (!data) return { content: [{ type: "text", text: "Stopped Tempus timer, but it was under one second so no entry was saved." }] };
      const project = data.project?.name || data.project_id || "unknown project";
      const description = data.description ? `: ${data.description}` : "";
      return { content: [{ type: "text", text: `Stopped Tempus timer and saved ${formatDuration(data.duration_ms)} on ${project}${description}.` }] };
    } catch (err) {
      return tempusToolError("tempus.timer.stop", err);
    }
  }
);

server.registerTool(
  "tempus.entries.today",
  {
    description: "List today's completed Tempus time entries.",
    inputSchema: {},
  },
  async () => {
    try {
      const { label, start, end } = dayBounds();
      const params = new URLSearchParams({
        from: start.toISOString(),
        to: end.toISOString(),
        limit: "100",
      });
      const data = await tempusFetch(`/time-entries?${params}`);
      const entries = data?.items ?? data ?? [];
      return { content: [{ type: "text", text: summarizeEntries(entries || [], `No Tempus entries found for today (${label}).`) }] };
    } catch (err) {
      return tempusToolError("tempus.entries.today", err);
    }
  }
);

server.registerTool(
  "tempus.entries.search",
  {
    description: "Search completed Tempus time entries by date range, project, and text.",
    inputSchema: {
      from: z.string().optional().describe("Inclusive start timestamp or date"),
      to: z.string().optional().describe("Inclusive end timestamp or date"),
      projectId: z.string().optional().describe("Tempus project id"),
      q: z.string().optional().describe("Text to match against description, project name, or tags"),
    },
  },
  async ({ from, to, projectId, q }) => {
    try {
      const start = normalizeRangeStart(from);
      const end = normalizeRangeEnd(to);
      const params = new URLSearchParams({ limit: "100" });
      if (projectId) params.set("projectId", projectId);
      if (start) params.set("from", start.toISOString());
      if (end) params.set("to", end.toISOString());
      const data = await tempusFetch(`/time-entries?${params}`);
      let entries = data?.items ?? data ?? [];
      if (q) {
        const needle = q.toLowerCase();
        entries = entries.filter((entry) => {
          const haystack = [
            entry.description,
            entry.project?.name,
            entry.project_id,
            ...(entry.tags || []),
          ].filter(Boolean).join(" ").toLowerCase();
          return haystack.includes(needle);
        });
      }
      return { content: [{ type: "text", text: summarizeEntries(entries, "No matching Tempus entries found.") }] };
    } catch (err) {
      return tempusToolError("tempus.entries.search", err);
    }
  }
);

server.registerTool(
  "tempus.projects.list",
  {
    description: "List active Tempus projects with their tracked totals.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await tempusFetch("/projects");
      const projects = data?.items ?? data ?? [];
      if (!projects?.length) return { content: [{ type: "text", text: "No active Tempus projects found." }] };
      const lines = projects.map((project) => {
        const stats = `${formatDuration(project.total_ms || 0)} across ${project.entry_count || 0} entries`;
        return `- ${project.name} (${project.id}): ${stats}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return tempusToolError("tempus.projects.list", err);
    }
  }
);

server.registerTool(
  "tempus.reports.daily",
  {
    description: "Summarize Tempus tracked time for one calendar day.",
    inputSchema: {
      date: z.string().optional().describe("Date as YYYY-MM-DD; defaults to today"),
    },
  },
  async ({ date } = {}) => {
    try {
      const { label } = dayBounds(date);
      const data = await tempusFetch("/time-entries/summary?period=today");
      return { content: [{ type: "text", text: summarizeReport(label, data) }] };
    } catch (err) {
      return tempusToolError("tempus.reports.daily", err);
    }
  }
);

server.registerTool(
  "tempus.reports.weekly",
  {
    description: "Summarize Tempus tracked time for one ISO-style Monday-start week.",
    inputSchema: {
      week: z.string().optional().describe("Week as YYYY-Www or any date inside the week; defaults to this week"),
    },
  },
  async ({ week } = {}) => {
    try {
      const { label } = weekBounds(week);
      const data = await tempusFetch("/time-entries/summary?period=week");
      return { content: [{ type: "text", text: summarizeReport(label, data) }] };
    } catch (err) {
      return tempusToolError("tempus.reports.weekly", err);
    }
  }
);

/* ─────────────────────────── gemini.execute ────────────────────────── */

// Executor tool — hands an imperative task to the local gemini CLI.
// Unlike the bash/write/edit tools above, gemini.execute does NOT route
// through the human-approval gate: it's a deterministic LLM call, not a
// destructive write to the host filesystem. The orchestrator (the caller
// asking for gemini.execute) is responsible for whatever side effects
// gemini is being asked to produce.
//
// Opt-in gate: gemini.execute drives the gemini CLI on the user's own Google
// login. OFF unless the operator opts in (SPECTRE_ALLOW_GEMINI_CLI=1). Mirrors
// the provider gate in src/lib/ai/providers/gemini-cli.ts so the brain can
// never reach it via a tool.
if (process.env.SPECTRE_ALLOW_GEMINI_CLI === "1") {
  registerGeminiExecute(server);
}

/* ─────────────────────────── openai tools ──────────────────────────── */

// openai.image — image generation via Codex CLI's built-in image_gen tool.
// openai.chat  — GPT subagent (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, etc.).
// Both use ChatGPT Plus subscription via `codex exec` — no OPENAI_API_KEY needed.
//
// Opt-in gate: drives the user's own ChatGPT subscription via codex exec.
// OFF unless the operator opts in (SPECTRE_ALLOW_CODEX_CLI=1). Mirrors
// src/lib/ai/providers/codex-cli.ts so the brain can never reach openai.* via a
// tool. (Image generation should move to a metered images API / a generation
// primitive — see the launch handoff.)
if (process.env.SPECTRE_ALLOW_CODEX_CLI === "1") {
  registerOpenAITools(server);
}

/* ─────────────────── user data tools (HTTP, from data dir) ─────────── */
// Declarative HTTP tools dropped into <SPECTRE_DATA_DIR>/tools/*.json. HTTP-only
// (no shell), so no new RCE surface; the lower-barrier complement to a full MCP
// server. Built-ins overlaid by user tools (same name wins).
try {
  registerDataTools(server);
} catch {
  /* a bad tool file must never stop the broker from starting */
}

/* ─────────────── user cli-command dispatch backends (RCE-gated) ─────── */
// dispatch.<id> tools generated from <SPECTRE_DATA_DIR>/backends/backends.json for
// cli-command backends with roles.dispatch. Spawns operator commands → gated behind
// SPECTRE_ALLOW_CLI_BACKENDS, same as gemini.execute / openai.* above.
if (process.env.SPECTRE_ALLOW_CLI_BACKENDS === "1") {
  try {
    registerCliDispatchTools(server);
  } catch {
    /* a bad backend file must never stop the broker from starting */
  }
}

/* ─────────────────────── Jerome Mode dispatch ─────────────────────── */

if (process.env.SPECTRE_ENABLE_DISPATCH_TOOL === "1") {
  registerDispatchToModel(server);
}

/* ──────────────────────────── screenshot ──────────────────────────── */

// Capture a web page (default: Spectre's own UI) via the Playwright shotter
// sidecar, store it on the SAME generated-images rail openai.image uses, and
// return a /generated/<id>.png URL. The brain embeds it as Markdown; the
// channel-runner turns that into a Telegram photo — so you can SEE what Jerome
// is doing while on the go. No approval gate (read-ish; writes only an image).
const SHOTTER_URL = process.env.SPECTRE_SHOTTER_URL || "http://shotter:8008/shot";
const SHELL_URL = process.env.SPECTRE_SHELL_URL || process.env.SPECTRE_APP_URL || "http://127.0.0.1:3100";
const SHOT_GENERATED_DIR = process.env.SPECTRE_GENERATED_DIR || join(process.cwd(), "public", "generated");

// Index an image in the recall layer (generated_media). Best-effort: a failure
// here must never break the screenshot itself — the image is already on disk.
async function recordMedia({ name, url, kind, caption }) {
  try {
    await appFetch("/generated/record", {
      method: "POST",
      body: JSON.stringify({ name, url, kind, caption, threadId: THREAD_ID }),
    });
  } catch (err) {
    console.error(`[spectre-mcp-broker] media record failed: ${err.message}`);
  }
}

server.registerTool(
  "screenshot",
  {
    description:
      "Capture a screenshot of a web page and return a /generated/<id>.png URL. Defaults to Spectre's own UI; pass `url` for any page. Embed the returned URL exactly once as Markdown ![](url) — on a channel like Telegram it is delivered as a photo so the user can see what's on screen. The shot is indexed for later recall (media.search), so pass a `caption`.",
    inputSchema: {
      url: z.string().optional().describe("Page URL to capture (default: Spectre's shell UI)"),
      fullPage: z.boolean().optional().describe("Capture the full scrollable page (default: just the viewport)"),
      selector: z.string().optional().describe("CSS selector to capture a single element"),
      caption: z
        .string()
        .optional()
        .describe(
          "Short description of what this screenshot shows. Indexed for semantic recall via media.search — be specific so it can be found again.",
        ),
    },
  },
  async ({ url, fullPage, selector, caption }) => {
    try {
      const target = typeof url === "string" && url ? url : SHELL_URL;
      const res = await fetch(SHOTTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: target,
          fullPage: !!fullPage,
          selector: selector || undefined,
          cookie: process.env.SPECTRE_SHOTTER_COOKIE || undefined,
        }),
        timeout: false,
      });
      if (!res.ok) {
        const msg = await res.text();
        return { isError: true, content: [{ type: "text", text: `screenshot failed (shotter ${res.status}): ${msg.slice(0, 200)}` }] };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(SHOT_GENERATED_DIR, { recursive: true });
      const name = `shot-${randomUUID()}.png`;
      await writeFile(join(SHOT_GENERATED_DIR, name), buf);
      const u = `/generated/${name}`;
      await recordMedia({ name, url: u, kind: "screenshot", caption: caption || `screenshot of ${target}` });
      return { content: [{ type: "text", text: `Screenshot captured: ${u}\nEmbed it exactly once as Markdown: ![](${u})` }] };
    } catch (err) {
      return toolErr("screenshot", err);
    }
  },
);

// Resurface a past screenshot / generated image by description — semantic recall
// over the captions in the media library. This is how Jerome "remembers" images
// it or the user made earlier and can show them again.
server.registerTool(
  "media.search",
  {
    description:
      "Search past screenshots and generated images by description (semantic recall over their captions). Use this to RESURFACE an image made earlier — e.g. 'the monitor dashboard screenshot' or 'the logo I generated'. Returns matching images; embed a returned URL once as Markdown ![](url) to show it again.",
    inputSchema: {
      query: z.string().describe("What the image shows / what you're looking for"),
      limit: z.number().optional().describe("Max results (default 6)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const n = Math.min(20, Math.max(1, limit || 6));
      const data = await appFetch(`/generated/library?q=${encodeURIComponent(query || "")}&limit=${n}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        return { content: [{ type: "text", text: `No saved media matched "${query}".` }] };
      }
      const lines = items
        .map((it) => {
          const when = it.createdAt ? String(it.createdAt).slice(0, 10) : "";
          const sim = typeof it.similarity === "number" ? ` (${Math.round(it.similarity * 100)}% match)` : "";
          return `- ${it.caption || it.name}${when ? ` — ${when}` : ""}${sim}\n  ![](${it.url})`;
        })
        .join("\n");
      return { content: [{ type: "text", text: `Found ${items.length} image(s):\n${lines}` }] };
    } catch (err) {
      return toolErr("media.search", err);
    }
  },
);

server.registerTool(
  "skill.read",
  {
    description:
      "Load the FULL instructions of a skill listed in the skill index. Call this before performing a skill's work.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    try {
      const skills = await appFetch("/skills");
      const skill = Array.isArray(skills) ? skills.find((s) => s.name === name) : null;
      if (!skill) {
        const names = Array.isArray(skills) ? skills.map((s) => s.name).join(", ") : "(none)";
        return { isError: true, content: [{ type: "text", text: `Unknown skill "${name}". Available: ${names}` }] };
      }
      // Telemetry must never block or fail a skill load — swallow every error.
      // Counts feed the weekly skill-curation proposal, nothing load-critical.
      appFetch(`/skills/${encodeURIComponent(name)}/used`, {
        method: "POST",
        body: JSON.stringify({ thread_id: THREAD_ID }),
      }).catch(() => {});
      return { content: [{ type: "text", text: skill.content }] };
    } catch (err) {
      return toolErr("skill.read", err);
    }
  }
);

/* ───────────────────────────── connect ─────────────────────────────── */

const transport = new StdioServerTransport();
await server.connect(transport);
