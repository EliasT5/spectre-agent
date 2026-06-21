/**
 * Per-module data store — the ONLY code that touches a module's data tables.
 *
 * SECURITY (the module trust boundary):
 *   - `createServiceSupabase()` is constructed and held HERE; it is NEVER
 *     returned, exposed, or handed to a binding. Callers (ctx.ts) get plain
 *     JSON values back, never a Supabase client/query builder.
 *   - EVERY query hard-filters `.eq("module_id", moduleId)`. A module can only
 *     ever read/write its OWN namespace; there is no parameter to widen it.
 *   - Token-resolved args arrive as PLAIN VALUES and are passed as query-builder
 *     PARAMETERS (never string-concatenated into SQL). `%`/`_` are escaped before
 *     any `.like()`.
 *   - All errors surface as opaque stable codes (thrown ModuleStoreError) — no
 *     SQL/stack/env ever leaks to a module or the client.
 *
 * Backs two tables (supabase/module-data.sql):
 *   module_kv   — namespaced key→jsonb   (get/set/list/del)
 *   module_rows — namespaced append log  (append/rows)
 */

import { createServiceSupabase } from "@/lib/supabase/server";

/** Opaque store failure. The dispatch maps this to a stable `module_error`. */
export class ModuleStoreError extends Error {
  constructor(public code = "store_error") {
    super(code);
    this.name = "ModuleStoreError";
  }
}

/** Escape LIKE wildcards so a prefix is matched literally (params, not concat). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ModuleRow {
  id: string;
  doc: unknown;
  created_at: string;
}

/** A KV read. Returns the stored JSON value, or null when the key is unset. */
export async function get(moduleId: string, key: string): Promise<unknown> {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("module_kv")
    .select("value")
    .eq("module_id", moduleId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new ModuleStoreError();
  return data?.value ?? null;
}

/** Upsert a KV value (per-module namespaced). */
export async function set(
  moduleId: string,
  key: string,
  value: unknown,
): Promise<{ ok: true }> {
  const supabase = createServiceSupabase();
  const { error } = await supabase
    .from("module_kv")
    .upsert(
      { module_id: moduleId, key, value, updated_at: new Date().toISOString() },
      { onConflict: "module_id,key" },
    );
  if (error) throw new ModuleStoreError();
  return { ok: true };
}

/** List KV keys in this module's namespace, optional literal prefix. */
export async function list(
  moduleId: string,
  prefix?: string,
): Promise<{ keys: string[] }> {
  const supabase = createServiceSupabase();
  let query = supabase
    .from("module_kv")
    .select("key")
    .eq("module_id", moduleId);
  if (typeof prefix === "string" && prefix.length > 0) {
    // Escaped prefix passed as a PARAMETER — never concatenated into SQL.
    query = query.like("key", `${escapeLike(prefix)}%`);
  }
  const { data, error } = await query.order("key", { ascending: true });
  if (error) throw new ModuleStoreError();
  return { keys: (data ?? []).map((r: { key: string }) => r.key) };
}

/** Delete a KV key in this module's namespace. */
export async function del(
  moduleId: string,
  key: string,
): Promise<{ ok: true }> {
  const supabase = createServiceSupabase();
  const { error } = await supabase
    .from("module_kv")
    .delete()
    .eq("module_id", moduleId)
    .eq("key", key);
  if (error) throw new ModuleStoreError();
  return { ok: true };
}

/** Append a JSON doc to a named collection (per-module namespaced). */
export async function append(
  moduleId: string,
  collection: string,
  doc: unknown,
): Promise<ModuleRow> {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("module_rows")
    .insert({ module_id: moduleId, collection, doc })
    .select("id, doc, created_at")
    .single();
  if (error || !data) throw new ModuleStoreError();
  return data as ModuleRow;
}

/** Read recent rows of a collection (newest first), clamp limit to 1..200. */
export async function rows(
  moduleId: string,
  collection: string,
  limit = 50,
): Promise<{ items: ModuleRow[] }> {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("module_rows")
    .select("id, doc, created_at")
    .eq("module_id", moduleId)
    .eq("collection", collection)
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw new ModuleStoreError();
  return { items: (data ?? []) as ModuleRow[] };
}
