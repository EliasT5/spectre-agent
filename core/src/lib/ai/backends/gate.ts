/**
 * Gate for user-taught model backends. Parallels `@/lib/ai/cli-gate` but is
 * string-keyed (backends are dynamic, not a fixed union) and governs the kinds
 * that SPAWN operator-supplied commands.
 *
 * `api` backends only register a model on the LiteLLM gateway (no local process),
 * so they are NOT gated here — same trust level as the existing /model/new path.
 * `cli-server` and `cli-command` spawn arbitrary commands = RCE by design, so they
 * are gated behind the operator master flag `SPECTRE_ALLOW_CLI_BACKENDS=1`
 * (default OFF), the same shape as `SPECTRE_ALLOW_CLI_UI` for the subscription CLIs.
 */
import { spawn } from "child_process";
import type { BackendKind, ModelBackend } from "./schema";
import { isCliBackendsAllowed } from "@/lib/feature-flags";

// Operator master switch: may cli-server / cli-command backends run at all? Now a
// runtime feature flag (Settings -> Danger Zone) with an env fallback. Re-exported
// for the callers that gate on it.
export { isCliBackendsAllowed };

/** Does this kind spawn an operator-supplied command (→ needs the master flag)? */
export function kindSpawns(kind: BackendKind): boolean {
  return kind === "cli-server" || kind === "cli-command";
}

/** True when a backend of this kind is permitted to exist/run. */
export function backendKindAllowed(kind: BackendKind): boolean {
  return kindSpawns(kind) ? isCliBackendsAllowed() : true;
}

/** Throw (with a clear reason) when a spawning kind is used but the flag is off. */
export function assertBackendAllowed(kind: BackendKind): void {
  if (!backendKindAllowed(kind)) {
    throw new Error(
      "cli-server / cli-command backends are disabled. Set SPECTRE_ALLOW_CLI_BACKENDS=1 " +
        "on the core to enable them (they spawn operator-supplied commands — RCE by design).",
    );
  }
}

/**
 * Gate-independent presence probe for the Settings status dot: "is the command
 * runnable?" Answers regardless of enabled state. api backends have no local
 * command, so they report true (their real health is the gateway).
 */
export function probeBackend(spec: ModelBackend): Promise<boolean> {
  if (spec.kind === "api" || !spec.command) return Promise.resolve(true);
  const cmd = spec.command;
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, ["--version"], { stdio: "ignore" });
      const t = setTimeout(() => {
        try { proc.kill(); } catch { /* noop */ }
        resolve(false);
      }, 5000);
      proc.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
      proc.on("error", () => { clearTimeout(t); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}
