import type { ChildProcess } from "child_process";

/**
 * Kill a child process and everything it spawned (e.g. an MCP broker).
 *
 * The child must have been spawned with `detached: true` so it sits at
 * the head of its own process group; that lets us reach descendants with
 * `process.kill(-pid, …)`. Falls back to a direct kill on Windows or
 * when the group kill races with the process exiting on its own.
 *
 * Uses SIGKILL on purpose: this is invoked from the Stop button. SIGTERM
 * lets Claude CLI finish its in-flight Anthropic response (~30 s of
 * "still thinking") before exiting; SIGKILL makes the abort actually
 * abort. Partial assistant content already written to the DB placeholder
 * is preserved by the messages-route finally block.
 */
export function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid || proc.exitCode !== null) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
