/**
 * MCP tool catalog — single source of truth for what the LLM is told
 * about Jerome's MCP tools.
 *
 * Reads `spectre-mcp-broker/tools-catalog.json` (the same file
 * `tools.list` serves to the broker UI) and renders a system-prompt
 * block tailored to each chat backend. This kills the failure mode
 * where the model hallucinates `mcp__memory__…` or routes through
 * `ToolSearch` to "discover" tools that are already in its tool list:
 * the names below are exact, complete, and authoritative.
 *
 * Add or remove an entry in tools-catalog.json and every provider's
 * system prompt updates on the next turn — the catalog is mtime-cached
 * so repeated calls are cheap.
 */

import { readFileSync, statSync } from "fs";
import { join } from "path";

export type McpProviderKey = "claude-code" | "codex-cli" | "gemini-cli";

export interface McpToolEntry {
  category: string;
  /** Catalog key, e.g. "memory.search". Dots become underscores in the harness-visible name. */
  name: string;
  description: string;
}

interface CachedCatalog {
  mtimeMs: number;
  entries: McpToolEntry[];
}

let cache: CachedCatalog | null = null;

function catalogPath(): string {
  const root = process.env.SPECTRE_REPO_PATH || process.cwd();
  return join(root, "spectre-mcp-broker", "tools-catalog.json");
}

function loadCatalog(): McpToolEntry[] {
  const path = catalogPath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return cache?.entries ?? [];
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.entries;

  try {
    const raw = readFileSync(path, "utf-8");
    const entries = JSON.parse(raw) as McpToolEntry[];
    cache = { mtimeMs, entries };
    return entries;
  } catch {
    return cache?.entries ?? [];
  }
}

/** Broker convention (spectre-mcp-broker/index.mjs:108): mcp__spectre__<name with . → _>. */
export function visibleToolName(name: string): string {
  return `mcp__spectre__${name.replaceAll(".", "_")}`;
}

export interface RenderOptions {
  /** When true, include `dispatch_to_model` (only mounted in Jerome Mode). */
  jeromeMode?: boolean;
}

/**
 * Returns a system-prompt block describing Jerome's MCP tools for the
 * given chat backend. Empty string if the catalog can't be read — the
 * caller should treat that as "no extra block" rather than failing.
 */
export function renderMcpToolBlock(
  provider: McpProviderKey,
  opts: RenderOptions = {},
): string {
  const entries = loadCatalog().filter((e) => {
    if (e.name === "dispatch_to_model") return opts.jeromeMode === true;
    return true;
  });
  if (entries.length === 0) return "";

  if (provider === "claude-code") return renderForClaudeCode(entries);
  return renderForHeadlessCli(provider);
}

function renderForClaudeCode(entries: McpToolEntry[]): string {
  const grouped = new Map<string, McpToolEntry[]>();
  for (const e of entries) {
    const bucket = grouped.get(e.category) ?? [];
    bucket.push(e);
    grouped.set(e.category, bucket);
  }
  const sortedCategories = [...grouped.keys()].sort();
  const blocks: string[] = [];
  for (const cat of sortedCategories) {
    const lines = [`## ${cat}`];
    const tools = grouped.get(cat)!.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of tools) {
      lines.push(`- \`${visibleToolName(e.name)}\` — ${e.description}`);
    }
    blocks.push(lines.join("\n"));
  }
  const catalog = blocks.join("\n\n");

  return [
    "# Jerome MCP tools",
    "",
    "These tools are already registered on the `jerome` MCP server and",
    "appear in your tool list right now. The names below are exact,",
    "complete, and authoritative — call them directly.",
    "",
    catalog,
    "",
    "Rules:",
    "- The naming convention is `mcp__spectre__<name>` with dots in the",
    "  catalog key replaced by underscores (e.g. `memory.search` →",
    "  `mcp__spectre__memory_search`). There is exactly one server,",
    "  named `jerome` — don't invent prefixes like `mcp__memory__` or",
    "  `mcp__notes__`. They don't exist.",
    "- Don't use `ToolSearch` to find these. `ToolSearch` only loads the",
    "  built-in deferred tools listed in the harness's system reminder",
    "  (WebFetch, WebSearch, TaskCreate, etc.). MCP tools are not",
    "  deferred and don't have schemas to fetch.",
    "- If a tool isn't listed above, it doesn't exist on this server.",
    "  Don't speculate that it lives on a sibling server, in a workspace",
    "  clone, or behind a feature flag. The catalog is the contract.",
    "- If a single call fails, retry once with corrected arguments before",
    "  giving up. Don't fabricate an explanation about missing config.",
    "- For image generation, call `mcp__spectre__openai_image` and embed",
    "  the returned `/generated/...` URL exactly once as Markdown.",
  ].join("\n");
}

function renderForHeadlessCli(provider: McpProviderKey): string {
  const cliName = provider === "codex-cli" ? "Codex CLI" : "Gemini CLI";
  return [
    "# Jerome MCP tools (not available to you)",
    "",
    `You're running as ${cliName} inside Jerome. The Jerome MCP tools`,
    "(memory, notes, calendar, image generation,",
    "schedules, etc.) live on Claude Code's",
    "broker — they are NOT mounted in this process. Calls of the form",
    "`mcp__spectre__*` will fail here and so will any other Jerome-",
    "branded MCP tool name.",
    "",
    "If the user (or the orchestrator) asks for something that requires",
    "a Jerome tool — saving a memory, generating an image, reading the",
    "calendar, scheduling a job —",
    "say so plainly and suggest routing through a Claude Code chat (or",
    "returning a result that flags the missing capability). Don't",
    "pretend the tool exists, don't hallucinate an MCP call, and don't",
    "search for tools to load — there are none to find.",
    "",
    "Your own native CLI tools (file edits, shell, etc.) are unaffected",
    "by this rule; use them as normal for the work you can do directly.",
  ].join("\n");
}
