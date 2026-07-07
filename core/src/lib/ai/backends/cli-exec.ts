/**
 * Shared spawn helper for cli-command backends — used by BOTH roles: the cli-text
 * brain streamer (core) and the mcp-broker's dispatch tool (which keeps its own
 * copy in .mjs, since the broker can't import core `@/` modules).
 *
 * Feeds a prompt to a user-supplied command per `promptMode`, collects stdout with
 * a hard size cap + timeout + abort signal, and parses the result per `outputMode`.
 * The child gets a CLEAN env (never the core's CORE_TOKEN / Supabase keys) and is
 * spawned detached so the whole process tree can be killed on cancel.
 */
import { spawn } from "child_process";
import { killProcessTree } from "../providers/process-group";
import type { ModelBackend } from "./schema";

const MAX_OUTPUT = 256 * 1024; // 256 KiB, mirrors the broker's tool-result cap

const CLEAN_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ComSpec", "windir",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
];

/** Minimal, SAFE env: PATH-ish basics + the backend's own declared env only. */
export function cleanEnv(declared: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of CLEAN_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string") base[k] = v;
  }
  return { ...base, ...declared };
}

function interpolate(args: string[], model?: string): string[] {
  return args.map((a) => a.replace(/\{model\}/g, model ?? ""));
}

function dotPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

export interface RunOpts {
  signal?: AbortSignal;
  /** Incremental stdout callback (stdout mode only). */
  onChunk?: (text: string) => void;
}

/** Run a cli-command backend once; resolves with the parsed text output. */
export function runCliCommand(spec: ModelBackend, prompt: string, opts: RunOpts = {}): Promise<string> {
  const args = interpolate(spec.args ?? [], spec.model);
  const promptMode = spec.promptMode ?? "stdin";
  if (promptMode === "arg" && spec.promptFlag) args.push(spec.promptFlag, prompt);
  else if (promptMode === "positional") args.push(prompt);

  const proc = spawn(spec.command as string, args, {
    env: cleanEnv(spec.env),
    stdio: [promptMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
    detached: true,
  });

  return new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    let truncated = false;
    let settled = false;
    const timeoutMs = spec.timeoutMs ?? 300_000;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      settle(() => reject(new Error(`cli backend '${spec.id}' timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const onAbort = () => {
      killProcessTree(proc);
      settle(() => reject(new Error("aborted")));
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort);
    }

    if (promptMode === "stdin") {
      try {
        proc.stdin?.write(prompt);
        proc.stdin?.end();
      } catch {
        /* stdin may already be closed */
      }
    }

    proc.stdout?.on("data", (d: Buffer) => {
      if (truncated) return;
      const s = d.toString();
      if (out.length + s.length > MAX_OUTPUT) {
        out += s.slice(0, MAX_OUTPUT - out.length);
        truncated = true;
      } else {
        out += s;
        if (spec.outputMode !== "json" && opts.onChunk) opts.onChunk(s);
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString();
    });

    proc.on("error", (e) => settle(() => reject(e)));
    proc.on("close", (code) => settle(() => {
      if (code !== 0 && !out.trim()) {
        reject(new Error(`cli backend '${spec.id}' exited with code ${code}: ${err.slice(0, 500)}`));
        return;
      }
      let text = out;
      if (spec.outputMode === "json") {
        try {
          const parsed: unknown = JSON.parse(out);
          if (spec.outputJsonPath) {
            const v = dotPath(parsed, spec.outputJsonPath);
            text = typeof v === "string" ? v : JSON.stringify(v ?? "");
          } else {
            text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
          }
        } catch {
          text = out; // not JSON after all — fall back to raw
        }
      }
      resolve(text.trim());
    }));
  });
}
