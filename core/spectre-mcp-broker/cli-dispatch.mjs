/**
 * dispatch.<id> — MCP tools generated from user-taught cli-command backends that
 * opted into the `dispatch` role. Lets an agentic brain hand a prompt to another
 * model (a local CLI) mid-turn and get its text back — multi-model orchestration.
 *
 * Specs come from `<SPECTRE_DATA_DIR>/backends/backends.json` (the core materializes
 * this from the DB; the broker has no DB access). The whole registrar is gated in
 * index.mjs behind SPECTRE_ALLOW_CLI_BACKENDS=1 — spawning operator commands is RCE
 * by design, same trust model as gemini.execute / openai.*.
 *
 * The child gets a CLEAN env (never CORE_TOKEN / Supabase keys). Mirrors the core's
 * src/lib/ai/backends/cli-exec.ts (kept as a self-contained copy).
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const MAX_OUTPUT = 256 * 1024; // 256 KiB
const CLEAN_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec", "windir",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
];

function dataDir() {
  return process.env.SPECTRE_DATA_DIR || join(process.env.SPECTRE_REPO_PATH || process.cwd(), ".data");
}

function cleanEnv(declared = {}) {
  const base = {};
  for (const k of CLEAN_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string") base[k] = v;
  }
  return { ...base, ...declared };
}

function interpolate(args, model) {
  return (args || []).map((a) => String(a).replace(/\{model\}/g, model ?? ""));
}

function dotPath(obj, path) {
  return String(path).split(".").reduce((acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined), obj);
}

function loadDispatchBackends() {
  const file = join(dataDir(), "backends", "backends.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const backends = parsed?.backends;
    if (!backends || typeof backends !== "object") return [];
    return Object.values(backends).filter(
      (b) => b && b.kind === "cli-command" && b.enabled !== false && b.roles && b.roles.dispatch,
    );
  } catch {
    return [];
  }
}

/** Spawn a cli-command backend once with `prompt`; resolve { output, isError }. */
function runCommand(spec, prompt, signal) {
  const args = interpolate(spec.args, spec.model);
  const promptMode = spec.promptMode || "stdin";
  if (promptMode === "arg" && spec.promptFlag) args.push(spec.promptFlag, prompt);
  else if (promptMode === "positional") args.push(prompt);
  const timeoutMs = typeof spec.timeoutMs === "number" ? spec.timeoutMs : 300_000;

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let truncated = false;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(payload);
    };
    let proc;
    try {
      proc = spawn(spec.command, args, {
        env: cleanEnv(spec.env || {}),
        stdio: [promptMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ output: "", isError: true, error: `failed to spawn: ${e?.message || e}` });
    }
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* dead */ }
      finish({ output: out, isError: true, error: `timeout after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    const onAbort = () => {
      try { proc.kill("SIGKILL"); } catch { /* dead */ }
      finish({ output: out, isError: true, error: "cancelled by caller" });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (promptMode === "stdin") {
      try { proc.stdin.write(prompt); proc.stdin.end(); } catch { /* closed */ }
    }
    proc.stdout.on("data", (d) => {
      if (truncated) return;
      const s = d.toString();
      if (out.length + s.length > MAX_OUTPUT) { out += s.slice(0, MAX_OUTPUT - out.length); truncated = true; }
      else out += s;
    });
    proc.stderr.on("data", (d) => { if (err.length < 4096) err += d.toString(); });
    proc.on("error", (e) => finish({ output: "", isError: true, error: `spawn error: ${e?.message || e}` }));
    proc.on("close", (code) => {
      if (code !== 0 && !out.trim()) return finish({ output: "", isError: true, error: `exited ${code}: ${err.slice(0, 300)}` });
      let text = out;
      if (spec.outputMode === "json") {
        try {
          const parsed = JSON.parse(out);
          text = spec.outputJsonPath
            ? (typeof dotPath(parsed, spec.outputJsonPath) === "string" ? dotPath(parsed, spec.outputJsonPath) : JSON.stringify(dotPath(parsed, spec.outputJsonPath) ?? ""))
            : (typeof parsed === "string" ? parsed : JSON.stringify(parsed));
        } catch { text = out; }
      }
      finish({ output: text.trim(), isError: false });
    });
  });
}

/**
 * Register a dispatch.<id> tool for each dispatch-enabled cli-command backend.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerCliDispatchTools(server) {
  for (const spec of loadDispatchBackends()) {
    const safeId = String(spec.id).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 56);
    const name = `dispatch.${safeId}`;
    server.registerTool(
      name,
      {
        description:
          `Dispatch a self-contained prompt to the '${spec.label}' model backend (a local CLI) and return its text output. ` +
          `Use to get another model's take on a sub-task mid-answer.`,
        inputSchema: {
          prompt: z.string().min(1).describe(`A complete, self-contained prompt for ${spec.label}.`),
        },
      },
      async (input, extra) => {
        const res = await runCommand(spec, input.prompt, extra?.signal);
        return {
          isError: res.isError,
          content: [{ type: "text", text: res.output || res.error || "(no output)" }],
        };
      },
    );
  }
}
