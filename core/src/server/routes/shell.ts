import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const shell = new Hono();

type ShellKind = "bash" | "pwsh";

interface ShellRequest {
  command?: unknown;
  shell?: unknown;
  cwd?: unknown;
}

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_CWD = process.env.SPECTRE_REPO_PATH || process.cwd();
const CWD_MARKER = "__SPECTRE_CWD:";

/**
 * Build a minimal, secret-free env for shell child processes.
 * Mirrors the safeEnv() pattern in workspace.ts (same key list) plus
 * Windows-specific vars required by pwsh / cmd.exe on win32.
 * Explicitly excludes: CORE_TOKEN, SPECTRE_SERVICE_TOKEN, SUPABASE_*,
 * *_API_KEY, *_TOKEN, PIN_HASH, SESSION_SECRET, LITELLM_*.
 */
function shellSafeEnv(): NodeJS.ProcessEnv {
  const POSIX_KEYS = [
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH",
  ];
  // Windows vars needed by pwsh.exe / cmd.exe
  const WIN32_KEYS = [
    "SystemRoot", "SystemDrive", "WINDIR",
    "USERPROFILE", "USERNAME", "COMPUTERNAME",
    "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    "OS",
  ];
  const allowed = process.platform === "win32"
    ? [...POSIX_KEYS, ...WIN32_KEYS]
    : POSIX_KEYS;

  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

shell.post("/", async (c) => {
  let body: ShellRequest;
  try {
    body = (await c.req.json()) as ShellRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const command = typeof body.command === "string" ? body.command : "";
  const shellKind: ShellKind = body.shell === "pwsh" ? "pwsh" : "bash";
  const requestedCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : DEFAULT_CWD;
  const cwd = existsSync(requestedCwd) ? requestedCwd : DEFAULT_CWD;

  if (!command.trim()) {
    return c.json({ error: "command required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;
    let bytesEmitted = 0;
    let truncated = false;
    let proc: ChildProcessWithoutNullStreams | null = null;

    async function send(event: string, data: unknown) {
      if (closed || stream.aborted) return;
      await stream.write(sseFrame(event, data));
    }

    function close() {
      closed = true;
    }

    const { bin, args } =
      shellKind === "pwsh"
        ? { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "-"] }
        : { bin: "bash", args: ["-s"] };

    await send("start", { shell: shellKind, bin });

    try {
      proc = spawn(bin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellSafeEnv(),
      });
    } catch (err) {
      await send("error", { message: (err as Error).message });
      await send("exit", { code: -1, signal: null, timedOut: false });
      close();
      return;
    }

    const timer = setTimeout(() => {
      truncated = true;
      void send("error", { message: `timeout after ${TIMEOUT_MS}ms` });
      proc?.kill("SIGKILL");
    }, TIMEOUT_MS);

    let stdoutBuf = "";
    let finalCwd: string | null = null;

    async function emitChunkRaw(channel: "stdout" | "stderr", text: string) {
      if (closed || !text) return;
      const byteLen = Buffer.byteLength(text, "utf8");
      if (bytesEmitted >= MAX_OUTPUT_BYTES) {
        if (!truncated) {
          truncated = true;
          await send("error", { message: `output truncated at ${MAX_OUTPUT_BYTES} bytes` });
          proc?.kill("SIGKILL");
        }
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - bytesEmitted;
      if (byteLen > remaining) {
        const sliced = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
        bytesEmitted += remaining;
        await send(channel, { chunk: sliced });
        return;
      }
      bytesEmitted += byteLen;
      await send(channel, { chunk: text });
    }

    async function flushStdout(force = false) {
      if (closed) return;
      const parts = stdoutBuf.split("\n");
      stdoutBuf = force ? "" : (parts.pop() ?? "");
      const passthrough: string[] = [];
      for (const line of parts) {
        if (line.startsWith(CWD_MARKER)) {
          finalCwd = line.slice(CWD_MARKER.length).trim();
        } else {
          passthrough.push(line);
        }
      }
      if (force && stdoutBuf) {
        if (stdoutBuf.startsWith(CWD_MARKER)) {
          finalCwd = stdoutBuf.slice(CWD_MARKER.length).trim();
        } else {
          passthrough.push(stdoutBuf);
        }
        stdoutBuf = "";
      }
      if (passthrough.length === 0) return;
      const chunk = passthrough.join("\n") + (force && parts.length === 0 ? "" : "\n");
      await emitChunkRaw("stdout", chunk);
    }

    proc.stdout.on("data", (b: Buffer) => {
      stdoutBuf += b.toString("utf8");
      void flushStdout(false);
    });
    proc.stderr.on("data", (b: Buffer) => {
      void emitChunkRaw("stderr", b.toString("utf8"));
    });

    const done = new Promise<void>((resolve) => {
      proc?.on("error", (err) => {
        clearTimeout(timer);
        void (async () => {
          await flushStdout(true);
          await send("error", { message: err.message });
          if (finalCwd) await send("cwd", { cwd: finalCwd });
          await send("exit", { code: -1, signal: null, timedOut: truncated });
          close();
          resolve();
        })();
      });

      proc?.on("close", (code, signal) => {
        clearTimeout(timer);
        void (async () => {
          await flushStdout(true);
          if (finalCwd) await send("cwd", { cwd: finalCwd });
          await send("exit", {
            code: code ?? -1,
            signal: signal ?? null,
            timedOut: truncated,
          });
          close();
          resolve();
        })();
      });
    });

    const suffix =
      shellKind === "pwsh"
        ? `\nWrite-Host "${CWD_MARKER}$((Get-Location).Path)"\n`
        : `\nprintf '%s%s\\n' '${CWD_MARKER}' "$(pwd)"\n`;
    proc.stdin.write(command + suffix);
    proc.stdin.end();

    while (!closed && !stream.aborted) {
      await Promise.race([done, stream.sleep(250)]);
    }
    if (stream.aborted) proc.kill("SIGKILL");
  });
});
