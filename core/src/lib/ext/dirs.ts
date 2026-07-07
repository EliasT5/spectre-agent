/**
 * Extension directories — the harness's user-extensible surface.
 *
 * Spectre ships BUILT-IN skills/tools/mcp baked into the (read-only) core image,
 * and overlays USER-provided ones from a persistent, host-mounted DATA DIR. This
 * is what makes an installed Spectre a real, extensible agent harness: drop a
 * skill / tool / MCP server into the data dir (or add one via the API) and it
 * survives restarts + image re-pulls.
 *
 *   built-in:  <projectRoot>/<kind>        (baked, read-only)
 *   user:      <SPECTRE_DATA_DIR>/<kind>   (mounted volume, writable)
 *
 * Overlay rule: a user entry with the same name OVERRIDES the built-in one.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type ExtKind = "skills" | "tools" | "mcp" | "modules" | "backends";

/** Repo/working root the baked built-ins live under (cwd in the prod image). */
export function projectRoot(): string {
  return process.env.SPECTRE_REPO_PATH || process.cwd();
}

/**
 * The persistent, user-writable data dir. Host-mounted at /data in the shipped
 * stack (docker-compose); falls back to <projectRoot>/.data in local dev so the
 * same code path works without a mount.
 */
export function dataDir(): string {
  return process.env.SPECTRE_DATA_DIR || join(projectRoot(), ".data");
}

/** Baked, read-only built-in dir for a kind. */
export function builtinDir(kind: ExtKind): string {
  return join(projectRoot(), kind);
}

/** User-writable dir for a kind (under the data dir). */
export function userDir(kind: ExtKind): string {
  return join(dataDir(), kind);
}

/** [source, dir] pairs to scan in overlay order (built-in first, user last). */
export function overlayDirs(kind: ExtKind): Array<["builtin" | "user", string]> {
  return [
    ["builtin", builtinDir(kind)],
    ["user", userDir(kind)],
  ];
}

/**
 * An external MCP server the operator registered. Either a local STDIO server
 * (`command` + `args` + optional `env`) or a remote one (`url`, SSE/HTTP).
 */
export interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Load external MCP servers from `<kind>/servers.json` (built-in overlaid by
 * user; a user entry with the same name wins). Shape:
 *   { "servers": { "<name>": { "command": "...", "args": [], "env": {} } |
 *                              { "url": "https://host/mcp" } } }
 * Invalid/incomplete entries are skipped (fail-safe — a bad config never throws).
 */
export function loadMcpServers(): McpServerSpec[] {
  const map = new Map<string, McpServerSpec>();
  for (const [, dir] of overlayDirs("mcp")) {
    const file = join(dir, "servers.json");
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const servers = (parsed as { servers?: unknown })?.servers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const command = typeof s.command === "string" ? s.command : undefined;
      const url = typeof s.url === "string" ? s.url : undefined;
      if (!command && !url) continue; // must have one transport
      map.set(name, {
        name,
        command,
        url,
        args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [],
        env:
          s.env && typeof s.env === "object"
            ? Object.fromEntries(
                Object.entries(s.env as Record<string, unknown>).filter(
                  ([, v]) => typeof v === "string",
                ) as [string, string][],
              )
            : {},
      });
    }
  }
  return [...map.values()];
}

/**
 * Load raw model-backend specs from `backends/backends.json` (built-in overlaid
 * by user; a user entry with the same id wins). Shape:
 *   { "backends": { "<id>": { …ModelBackend spec… } } }
 * Returns raw objects keyed by id — the caller (registry) validates them with the
 * zod schema. Fail-safe: a bad file is skipped, never throws. This is the SAME
 * file the mcp-broker reads to register cli-dispatch tools (it has no DB access),
 * so the registry keeps it materialized from the DB.
 */
export function loadModelBackendSpecs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [, dir] of overlayDirs("backends")) {
    const file = join(dir, "backends.json");
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const backends = (parsed as { backends?: unknown })?.backends;
    if (!backends || typeof backends !== "object") continue;
    for (const [id, raw] of Object.entries(backends as Record<string, unknown>)) {
      if (raw && typeof raw === "object") out[id] = raw; // user dir last → overrides
    }
  }
  return out;
}

export interface LoadedSkill {
  name: string;
  content: string;
  source: "builtin" | "user";
}

/**
 * Load all skill docs (built-in overlaid by user). A user skill with the same
 * directory name as a built-in REPLACES it (user dir is scanned last). Each skill
 * is a directory containing a SKILL.md.
 */
export function loadSkillDocs(): LoadedSkill[] {
  const map = new Map<string, LoadedSkill>();
  for (const [source, dir] of overlayDirs("skills")) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      let content = "";
      try {
        content = readFileSync(join(dir, d.name, "SKILL.md"), "utf-8").trim();
      } catch {
        continue;
      }
      if (content) map.set(d.name, { name: d.name, content, source });
    }
  }
  return [...map.values()];
}
