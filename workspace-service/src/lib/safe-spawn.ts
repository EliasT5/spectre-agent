/**
 * safeSpawn – execve-style process spawning with an explicit env allowlist.
 *
 * Security properties enforced here (BRD-04 §2):
 *  - shell: false  → no shell interpretation; user input cannot inject commands.
 *  - Explicit env allowlist → child process cannot inherit secrets from parent env.
 *  - GH_TOKEN injected by server only; never accepted from client input.
 *  - cwd is ALWAYS server-controlled (slot root); client cwd hints are ignored.
 *  - argv arrays only; never string concatenation.
 *
 * Ported verbatim from the Spectre monolith
 * (src/lib/workspace-server/safe-spawn.ts). The only change is the relative
 * import extension (`./sse-redact.js`) required by NodeNext module resolution.
 */
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Transform } from 'stream';
import { redactLine } from './sse-redact.js';

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'NODE_PATH',
] as const;

export interface SafeSpawnOptions {
  /** Server-controlled working directory (slot root). NEVER from client. */
  cwd: string;
  /** GH_TOKEN injected by server for gh/git remote operations. */
  ghToken?: string;
  /** Kill timeout in ms. */
  timeout?: number;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function buildEnv(ghToken?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (ghToken) {
    env.GH_TOKEN = ghToken;
    // The sandbox clone (`gh repo clone`) configures NO git credential.helper, and
    // this container has none either — so a plain `git push`/`fetch` prompts for a
    // username and fails non-interactively ("could not read Username"), breaking
    // finalize. Inject a github.com credential helper via GIT_CONFIG_* (env-based so
    // it needs no writable ~/.gitconfig); git runs the helper through a shell, which
    // expands $GH_TOKEN from the env above. `gh` reads GH_TOKEN directly, so this
    // only backfills the plain-git path (push/fetch).
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper";
    env.GIT_CONFIG_VALUE_0 = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  }
  return env;
}

/**
 * Spawns `cmd` with `args` using execve semantics.
 * Never passes user input through a shell.
 */
export function safeSpawn(
  cmd: string,
  args: string[],
  opts: SafeSpawnOptions,
): ChildProcess {
  return spawn(cmd, args, {
    shell: false,                   // CRITICAL: no shell interpolation
    // The allowlist intentionally drops NODE_ENV from the parent shell
    // so the child can't inherit it; strict ProcessEnv typing requires the cast.
    env: buildEnv(opts.ghToken) as NodeJS.ProcessEnv,
    cwd: opts.cwd,                  // server-controlled
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function runCommand(
  cmd: string,
  args: string[],
  opts: SafeSpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = safeSpawn(cmd, args, opts);

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${opts.timeout}ms: ${cmd}`));
      }, opts.timeout);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

/**
 * Returns a Transform stream that buffers input into lines, applies secret
 * redaction to each line, and re-emits them. Suitable for piping child
 * process stdout/stderr into an SSE response.
 */
export function createRedactingTransform(): Transform {
  let buffer = '';

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      // Last element may be an incomplete line; keep it in buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        this.push(redactLine(line) + '\n');
      }
      callback();
    },

    flush(callback) {
      if (buffer) {
        this.push(redactLine(buffer) + '\n');
        buffer = '';
      }
      callback();
    },
  });
}
