/**
 * Model-backend registry — the durable, dual-written store of user-taught backends.
 *
 * Written to TWO places on every change:
 *   1. Postgres `model_backends` (service-role RLS) — durability + the source of truth.
 *   2. `<dataDir>/backends/backends.json` — the mcp-broker reads this (it has NO DB
 *      access), and hand-dropped entries there overlay like `mcp/servers.json`.
 *
 * A synchronous in-memory snapshot lets `route()` resolve cli-command brain hints
 * without an async DB call (same pattern as cli-gate's override map). Fail-soft
 * throughout: a missing table / unreachable DB degrades to "data-dir only", never
 * throwing on a read path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadModelBackendSpecs, userDir } from "@/lib/ext/dirs";
import { validateBackend, type ModelBackend } from "./schema";

const snapshot = new Map<string, ModelBackend>();
let hydrated = false;

function backendsFile(): string {
  return join(userDir("backends"), "backends.json");
}

/** Merge data-dir specs (overlay) with DB rows (authoritative), validate, keep valid. */
async function loadAll(): Promise<Map<string, ModelBackend>> {
  const merged = new Map<string, unknown>();
  // 1) data-dir (hand-dropped or previously materialized)
  for (const [id, raw] of Object.entries(loadModelBackendSpecs())) merged.set(id, raw);
  // 2) DB overrides
  try {
    const supabase = createServiceSupabase();
    const { data, error } = await supabase.from("model_backends").select("spec");
    if (error) {
      // 42P01 = undefined_table (not migrated yet) → degrade to data-dir only
      if (error.code !== "42P01") console.warn("[backends] DB read failed:", error.message);
    } else if (Array.isArray(data)) {
      for (const row of data) {
        const spec = (row as { spec?: unknown }).spec;
        const id = (spec as { id?: unknown })?.id;
        if (typeof id === "string") merged.set(id, spec);
      }
    }
  } catch (e) {
    console.warn("[backends] DB unavailable, using data-dir only:", e instanceof Error ? e.message : e);
  }
  const out = new Map<string, ModelBackend>();
  for (const [id, raw] of merged) {
    const res = validateBackend(raw);
    if (res.ok) out.set(id, res.backend);
    else console.warn(`[backends] skipping invalid backend '${id}': ${res.errors.join("; ")}`);
  }
  return out;
}

/** Materialize the current snapshot to the data-dir file the broker reads. */
function writeDispatchFile(): void {
  try {
    const dir = userDir("backends");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const backends: Record<string, ModelBackend> = {};
    for (const [id, spec] of snapshot) backends[id] = spec;
    writeFileSync(backendsFile(), JSON.stringify({ backends }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn("[backends] failed to write backends.json:", e instanceof Error ? e.message : e);
  }
}

function replaceSnapshot(next: Map<string, ModelBackend>): void {
  snapshot.clear();
  for (const [k, v] of next) snapshot.set(k, v);
}

// ── Sync accessors (hot path — route(), models surfacing) ──────────────────────
export function getBackendSync(id: string): ModelBackend | undefined {
  return snapshot.get(id);
}
export function listBackendsSync(): ModelBackend[] {
  return [...snapshot.values()];
}

// ── Async authoritative API ────────────────────────────────────────────────────
export async function listBackends(): Promise<ModelBackend[]> {
  const all = await loadAll();
  replaceSnapshot(all);
  return [...all.values()];
}

async function persistRow(spec: ModelBackend): Promise<void> {
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("model_backends").upsert(
    {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      status: spec.enabled ? "enabled" : "disabled",
      spec: spec as unknown as Record<string, unknown>,
    },
    { onConflict: "id" },
  );
  if (error && error.code !== "42P01") throw new Error(`persist backend failed: ${error.message}`);
}

export async function upsertBackend(spec: ModelBackend): Promise<void> {
  await persistRow(spec);
  snapshot.set(spec.id, spec);
  writeDispatchFile();
}

export async function deleteBackend(id: string): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { error } = await supabase.from("model_backends").delete().eq("id", id);
    if (error && error.code !== "42P01") throw new Error(`delete backend failed: ${error.message}`);
  } finally {
    snapshot.delete(id);
    writeDispatchFile();
  }
}

export async function setBackendEnabled(id: string, on: boolean): Promise<ModelBackend | undefined> {
  const cur = snapshot.get(id);
  if (!cur) return undefined;
  const next = { ...cur, enabled: on };
  await upsertBackend(next);
  return next;
}

/** Boot reconciliation: load snapshot, rewrite the data-dir file, start cli-servers. */
export async function hydrateBackends(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    replaceSnapshot(await loadAll());
    writeDispatchFile();
    // Start enabled cli-server backends (dynamic import avoids a load-time cycle).
    const enabledServers = listBackendsSync().filter((b) => b.kind === "cli-server" && b.enabled);
    if (enabledServers.length) {
      const { startEnabledServers } = await import("./supervisor");
      await startEnabledServers(enabledServers);
    }
  } catch (e) {
    console.warn("[backends] hydrate failed:", e instanceof Error ? e.message : e);
  }
}

// Kick hydration off at module load (fire-and-forget), mirroring cli-gate.ts.
void hydrateBackends();
