/**
 * sdk-calls — the CLOSED, read-only @spectre/sdk dispatch table + its grant gate.
 *
 * Extracted from SchemaRuntime so BOTH the Data-mode schema runtime AND the
 * Code-mode postMessage bridge (module-bridge.ts) reach the SDK through the
 * EXACT SAME closed allowlist. There is one source of truth for "what untrusted
 * module code is allowed to call".
 *
 * `SDK_CALLS` is built from the REAL read-only fns in lib/sdk.ts — NO spectre.raw,
 * NO write/mutating method (no memory.add/forget, chat.*, ingest, config.set,
 * module backend writes). A call must be in THIS table AND granted by
 * `permissions.sdk` to run. Module-backend traffic is NOT here — it is
 * self-scoped (the id is hard-bound by the caller) and gated by manifest, not by
 * this sdk allowlist.
 */

import { spectre } from "@/lib/sdk";
import type { ModulePermissions } from "@/lib/module-manifest";
import type { Val } from "./schema-v2";

// ── the CLOSED sdk dispatch table ───────────────────────────────────────────
// The ONLY way a module reaches the SDK. Each entry is invoked with the caller's
// args. A call must be in THIS table AND granted by permissions.sdk to run.
export const SDK_CALLS: Record<string, (...args: Val[]) => Promise<unknown>> = {
  monitor: () => spectre.monitor(),
  health: () => spectre.health(),
  usage: () => spectre.usage(),
  models: () => spectre.models(),
  schedules: () => spectre.schedules(),
  calendar: () => spectre.calendar(),
  skills: () => spectre.skills(),
  "memory.search": (q) => spectre.memory.search(String(q ?? "")),
  "memory.list": () => spectre.memory.list(),
  "memory.searchThreads": (q) => spectre.memory.searchThreads(String(q ?? "")),
  "threads.list": () => spectre.threads.list(),
  ingestHistory: () => spectre.ingestHistory(),
};

/** Is this sdk call in the closed table AND granted by permissions.sdk? */
export function sdkAllowed(call: string, perms: ModulePermissions): boolean {
  if (!(call in SDK_CALLS)) return false;
  const granted = perms.sdk ?? [];
  return granted.includes(call);
}

/**
 * Is this a safe module-backend path?
 *
 * A module backend path must be a string and must not contain ".." (path
 * traversal). This is the shared guard used by BOTH the Code-mode bridge
 * (module-bridge.ts) and the Data-mode runtime (SchemaRuntime.tsx) so there
 * is a single source of truth. The core already rejects ".." server-side;
 * this is belt-and-suspenders parity.
 */
export function isSafeModulePath(path: unknown): path is string {
  return typeof path === "string" && !path.includes("..");
}
