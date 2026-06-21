/**
 * Data tools — user-defined, declarative HTTP tools loaded from the data dir.
 *
 * The lower-barrier complement to MCP: instead of writing an MCP server, drop a
 * `<name>.json` into `<SPECTRE_DATA_DIR>/tools/` describing an HTTP call, and the
 * agent gets a new tool. Built-in tools (the baked `tools/` dir) are overlaid by
 * user ones (same name wins). HTTP-ONLY by design — no shell, no process exec —
 * so this adds NO new RCE surface (for shell/code use the bash tool or an MCP
 * server). Arg values are URL-encoded on interpolation to prevent injection; the
 * URL host is fixed by the operator's template, so the agent can't redirect it.
 *
 * Format (tools/weather.json):
 *   {
 *     "name": "weather",
 *     "description": "Current weather for a city",
 *     "inputSchema": { "city": { "type": "string", "description": "City name" } },
 *     "http": {
 *       "method": "GET",
 *       "url": "https://api.example.com/weather?q={city}",
 *       "headers": { "Authorization": "Bearer {env.WEATHER_KEY}" }
 *     }
 *   }
 * {field} interpolates an arg; {env.NAME} interpolates an env var (kept off the
 * model). A non-GET `body` (string or object) is sent as JSON.
 */
import { z } from "zod";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function toolsDirs() {
  const root = process.env.SPECTRE_REPO_PATH || process.cwd();
  const dataDir = process.env.SPECTRE_DATA_DIR || join(root, ".data");
  return [join(root, "tools"), join(dataDir, "tools")]; // built-in, then user (user wins)
}

function zodFor(field) {
  const t = (field && field.type) || "string";
  let s = t === "number" ? z.number() : t === "boolean" ? z.boolean() : z.string();
  if (field && field.description) s = s.describe(field.description);
  if (field && field.optional) s = s.optional();
  return s;
}

function buildShape(inputSchema) {
  const shape = {};
  for (const [k, def] of Object.entries(inputSchema || {})) shape[k] = zodFor(def);
  return shape;
}

// Only env vars the operator explicitly exposes may be interpolated via {env.X},
// so a tool definition can't smuggle out {env.CORE_TOKEN} / {env.SUPABASE_*}.
const TOOL_ENV_ALLOW = new Set(
  (process.env.SPECTRE_TOOL_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean),
);

function interp(str, args, { encode } = {}) {
  return String(str).replace(/\{env\.(\w+)\}|\{(\w+)\}/g, (_m, envName, arg) => {
    let raw = "";
    if (envName) {
      raw = TOOL_ENV_ALLOW.has(envName) ? (process.env[envName] ?? "") : "";
    } else {
      raw = args[arg] != null ? String(args[arg]) : "";
    }
    return encode ? encodeURIComponent(raw) : raw;
  });
}

/** Collect built-in + user data-tool defs (user overrides by name). */
function loadDefs() {
  const defs = new Map();
  for (const dir of toolsDirs()) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      let def;
      try {
        def = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        continue;
      }
      const name = (def && def.name) || f.replace(/\.json$/, "");
      if (!def || !def.http || !def.http.url) continue; // HTTP-only
      defs.set(name, def);
    }
  }
  return defs;
}

/** Register every declarative HTTP tool found in the tools dirs. Returns names. */
export function registerDataTools(server) {
  const registered = [];
  for (const [name, def] of loadDefs()) {
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
    server.registerTool(
      safeName,
      {
        description: def.description || `Custom HTTP tool ${safeName}`,
        inputSchema: buildShape(def.inputSchema),
      },
      async (args = {}) => {
        try {
          const method = (def.http.method || "GET").toUpperCase();
          const url = interp(def.http.url, args, { encode: true });
          const headers = {};
          for (const [k, val] of Object.entries(def.http.headers || {})) headers[k] = interp(val, args);
          let body;
          if (def.http.body != null && method !== "GET" && method !== "HEAD") {
            body = typeof def.http.body === "string" ? interp(def.http.body, args) : JSON.stringify(def.http.body);
            if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
          }
          const res = await fetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(Number(def.http.timeoutMs) || 20000),
          });
          const text = await res.text();
          return {
            content: [{ type: "text", text: `HTTP ${res.status}\n${text.slice(0, 8000)}` }],
            isError: !res.ok,
          };
        } catch (e) {
          return { content: [{ type: "text", text: `tool ${safeName} failed: ${e.message}` }], isError: true };
        }
      },
    );
    registered.push(safeName);
  }
  return registered;
}
