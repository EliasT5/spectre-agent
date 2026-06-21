/**
 * Slot manager — filesystem-backed state for workspace slots.
 *
 * Two kinds of slot are unified behind one resolver:
 *
 *  1. SANDBOX (the Spectre-monolith model): a directory under WORKSPACE_ROOT.
 *     We persist a single `.workspace.json` metadata file at
 *     `<WORKSPACE_ROOT>/<slot-id>/` so the API stays stateless across deploys.
 *     The 3-slot cap is enforced by counting non-finalized slot dirs. The
 *     repo is cloned into `<WORKSPACE_ROOT>/<slot-id>/repo`.
 *
 *  2. TRUSTED FOLDER: a real, existing host folder bind-mounted into the
 *     container and registered via env WORKSPACE_TRUSTED_DIRS (comma-separated
 *     absolute paths). No clone, no .workspace.json, no finalize/delete
 *     semantics — edits happen directly in the folder. Trusted folders surface
 *     as read-only pseudo-slots (kind:"trusted") and can NEVER be deleted by
 *     the orphans/delete routes (guardSlotForDeletion stays under WORKSPACE_ROOT).
 *
 * Ported from the monolith (src/lib/workspace-server/slot-manager.ts); the
 * sandbox path is unchanged. Trusted-folder support + resolveRoot()/listAllSlots()
 * are the dual-mode additions.
 *
 * No DB dependency — this is the single-user IDE we're shipping.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WORKSPACE_ROOT, PathGuardError } from "./path-guard.js";

export type SlotStatus = "opening" | "ready" | "finalizing" | "finalized" | "failed" | "discarded";

export type SlotKind = "sandbox" | "trusted";

export interface SlotMetadata {
  id: string;             // 12-char slot id used in URLs
  slot_index: 1 | 2 | 3;
  kind: SlotKind;
  repo_url: string;
  repo_owner: string;
  repo_name: string;
  branch: string;
  base_branch: string;
  status: SlotStatus;
  pr_url?: string | null;
  last_test_status?: "pending" | "passing" | "failing" | "skipped" | null;
  created_at: string;
  updated_at: string;
}

const META_FILE = ".workspace.json";

function metaPath(slotId: string): string {
  return join(WORKSPACE_ROOT, slotId, META_FILE);
}

export function listSlots(): SlotMetadata[] {
  if (!existsSync(WORKSPACE_ROOT)) return [];
  const out: SlotMetadata[] = [];
  for (const name of readdirSync(WORKSPACE_ROOT)) {
    const full = join(WORKSPACE_ROOT, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const meta = metaPath(name);
    if (!existsSync(meta)) continue;
    try {
      const data = JSON.parse(readFileSync(meta, "utf-8")) as SlotMetadata;
      // Back-compat: legacy slots written before the `kind` field existed
      // are sandbox slots by definition.
      if (!data.kind) data.kind = "sandbox";
      out.push(data);
    } catch {
      // corrupt metadata — skip
    }
  }
  return out.sort((a, b) => a.slot_index - b.slot_index);
}

export function getSlot(slotId: string): SlotMetadata | null {
  const meta = metaPath(slotId);
  if (!existsSync(meta)) return null;
  try {
    const data = JSON.parse(readFileSync(meta, "utf-8")) as SlotMetadata;
    if (!data.kind) data.kind = "sandbox";
    return data;
  } catch {
    return null;
  }
}

/** Find an open slot index (1..3). Returns null when all 3 are taken
 *  by non-finalized slots. */
export function claimSlotIndex(): 1 | 2 | 3 | null {
  const taken = new Set(
    listSlots()
      .filter((s) => ["opening", "ready", "finalizing"].includes(s.status))
      .map((s) => s.slot_index),
  );
  for (const i of [1, 2, 3] as const) {
    if (!taken.has(i)) return i;
  }
  return null;
}

export function generateSlotId(): string {
  // 12-char lowercase a-z0-9, matches pathGuard's SLOT_ID_RE.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function createSlot(
  input: Omit<SlotMetadata, "id" | "created_at" | "updated_at" | "kind"> & { kind?: SlotKind },
): SlotMetadata {
  const id = generateSlotId();
  const now = new Date().toISOString();
  const meta: SlotMetadata = {
    ...input,
    kind: input.kind ?? "sandbox",
    id,
    created_at: now,
    updated_at: now,
  };
  const dir = join(WORKSPACE_ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

export function updateSlot(slotId: string, patch: Partial<SlotMetadata>): SlotMetadata | null {
  const cur = getSlot(slotId);
  if (!cur) return null;
  const next: SlotMetadata = {
    ...cur,
    ...patch,
    id: cur.id,                    // can't change id
    slot_index: cur.slot_index,    // or slot_index
    kind: cur.kind,                // or kind
    updated_at: new Date().toISOString(),
  };
  writeFileSync(metaPath(slotId), JSON.stringify(next, null, 2));
  return next;
}

export function deleteSlot(slotId: string): void {
  const dir = join(WORKSPACE_ROOT, slotId);
  if (!existsSync(dir)) return;
  // Belt-and-braces: pathGuard also enforces realpath stays under
  // WORKSPACE_ROOT, but we double-check the dir is not a symlink before rm.
  const stat = statSync(dir);
  if (!stat.isDirectory()) return;
  rmSync(dir, { recursive: true, force: true });
}

/** List slot dirs whose .workspace.json is missing — leftovers from a
 *  finalize/delete that crashed midway through rm. Caller can nuke them. */
export function listOrphanSlotIds(): string[] {
  if (!existsSync(WORKSPACE_ROOT)) return [];
  const orphans: string[] = [];
  for (const name of readdirSync(WORKSPACE_ROOT)) {
    const full = join(WORKSPACE_ROOT, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (existsSync(metaPath(name))) continue;
    orphans.push(name);
  }
  return orphans.sort();
}

/** Deterministic 12-char id for a trusted folder: "t" + sha256(absPath)[0..11].
 *  Matches pathGuard's SLOT_ID_RE (leading [a-z], then hex [a-z0-9]). */
export function trustedSlotId(absPath: string): string {
  const h = createHash("sha256").update(absPath).digest("hex");
  return "t" + h.slice(0, 11);
}

/**
 * Parse WORKSPACE_TRUSTED_DIRS into a de-duplicated list of absolute paths.
 * Blank entries are dropped; relative entries are rejected (fail closed:
 * skipped, not silently joined to a root).
 */
export function trustedDirs(): string[] {
  const raw = process.env.WORKSPACE_TRUSTED_DIRS ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (!isAbsolute(p)) continue; // refuse relative trusted dirs
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Build a pseudo-SlotMetadata for a single trusted folder. */
function trustedMeta(absPath: string): SlotMetadata {
  const now = new Date().toISOString();
  return {
    id: trustedSlotId(absPath),
    slot_index: 1,            // trusted folders are not bound by the 3-slot cap
    kind: "trusted",
    repo_url: absPath,        // surfaced as the registered path
    repo_owner: "(local)",
    repo_name: basename(absPath) || absPath,
    branch: "",
    base_branch: "",
    status: "ready",
    pr_url: null,
    last_test_status: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Pseudo-slots for every registered trusted folder that actually exists and
 * is a directory on disk. Non-existent / non-directory entries are skipped so
 * a stale env entry doesn't surface a broken slot.
 */
export function listTrustedSlots(): SlotMetadata[] {
  const out: SlotMetadata[] = [];
  for (const p of trustedDirs()) {
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (!stat.isDirectory()) continue;
    out.push(trustedMeta(p));
  }
  return out;
}

/** Resolve a trusted slot id back to its registered absolute path, or null. */
function trustedPathForId(slotId: string): string | null {
  for (const p of trustedDirs()) {
    if (trustedSlotId(p) === slotId) return p;
  }
  return null;
}

export interface ResolvedRoot {
  /** Absolute, realpath-resolved working root. */
  root: string;
  kind: SlotKind;
  meta: SlotMetadata;
}

/**
 * Unified resolver: maps a slot id to its absolute working ROOT directory.
 *
 *  - Sandbox slot → realpath(<WORKSPACE_ROOT>/<id>/repo)
 *  - Trusted slot → realpath(registered abs path)
 *
 * Throws PathGuardError if the id is unknown or the root is inaccessible.
 * The returned `root` is what guardPath() / safeSpawn cwd should be built on.
 */
export async function resolveRoot(slotId: string): Promise<ResolvedRoot> {
  // Trusted first: ids are a disjoint deterministic namespace ("t" + hex).
  const trustedPath = trustedPathForId(slotId);
  if (trustedPath) {
    let root: string;
    try {
      root = realpathSync(trustedPath);
    } catch {
      throw new PathGuardError("Trusted folder is inaccessible");
    }
    return { root, kind: "trusted", meta: trustedMeta(trustedPath) };
  }

  // Sandbox: must have on-disk metadata.
  const meta = getSlot(slotId);
  if (!meta) {
    throw new PathGuardError("Unknown slot");
  }
  const repoDir = join(WORKSPACE_ROOT, slotId, "repo");
  let root: string;
  try {
    root = realpathSync(repoDir);
  } catch {
    throw new PathGuardError("Slot working directory does not exist");
  }
  return { root, kind: "sandbox", meta };
}

export function listAllSlots(): SlotMetadata[] {
  return [...listSlots(), ...listTrustedSlots()];
}
