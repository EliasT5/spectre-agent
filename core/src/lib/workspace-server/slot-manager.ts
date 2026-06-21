/**
 * Slot manager — filesystem-backed state for the 3 workspace slots.
 *
 * Each slot is a directory under WORKSPACE_ROOT. We persist a single
 * `.workspace.json` metadata file at `<WORKSPACE_ROOT>/<slot-id>/` so
 * the API stays stateless across deploys. The 3-slot cap is enforced by
 * counting non-empty slot dirs.
 *
 * No DB dependency — Jerome doesn't have a per-user workspaces table
 * yet, and we don't need one for the single-user IDE we're shipping.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_ROOT } from "./path-guard";

export type SlotStatus = "opening" | "ready" | "finalizing" | "finalized" | "failed" | "discarded";

export interface SlotMetadata {
  id: string;             // 8-char slot id used in URLs
  slot_index: 1 | 2 | 3;
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
    return JSON.parse(readFileSync(meta, "utf-8")) as SlotMetadata;
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
  // 8-char lowercase a-z0-9, matches pathGuard's SLOT_ID_RE.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function createSlot(input: Omit<SlotMetadata, "id" | "created_at" | "updated_at">): SlotMetadata {
  const id = generateSlotId();
  const now = new Date().toISOString();
  const meta: SlotMetadata = { ...input, id, created_at: now, updated_at: now };
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
