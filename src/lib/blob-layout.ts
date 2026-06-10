/**
 * Blob layout — which modules sit in which blob's slots, and each blob's hue.
 *
 * Each blob holds up to MAX_SLOTS modules; adding past that spawns a new blob
 * (the signature multi-blob model). A module can also be UNASSIGNED (in no
 * blob) — it then lives in the customize menu's "stash", draggable back onto a
 * blob. Persisted in the core's generic KV (app_config/blob_layout) so it
 * survives + syncs across devices. The scene renders the active blob's slots;
 * zooming out shows the other blobs as a living constellation, each its colour.
 */

import { MODULES } from "./modules";

export const MAX_SLOTS = 10;

// Every blob defaults to Spectre's signature violet — no auto-assigned rainbow.
// A blob only differs in colour if the user explicitly recolours it (the swatch
// in the customize console writes `color`).
export const SIGNATURE_VIOLET = "#8b5cf6";
export function colorForIndex(_i: number): string {
  return SIGNATURE_VIOLET;
}

export interface Blob {
  id: string;
  label: string;
  slots: string[]; // module ids, length <= MAX_SLOTS
  color?: string; // hex hue; defaults by index
}
export type BlobLayout = Blob[];

/** A blob's effective colour (explicit, else by position). */
export function blobColor(blob: Blob | undefined, index: number): string {
  return blob?.color ?? colorForIndex(index);
}

let _seq = 0;
function newBlobId() {
  // No Date.now()/random in some runtimes; a monotonic-ish id is enough here.
  _seq += 1;
  return `blob-${_seq}-${MODULES.length}`;
}

/** Default: pack every registered module into blobs of <= MAX_SLOTS.
 *  `ids` defaults to the static MODULES seed; callers pass the live registry ids
 *  (incl. installed modules) so a fresh layout includes them. */
export function defaultLayout(ids: string[] = MODULES.map((m) => m.id)): BlobLayout {
  const blobs: BlobLayout = [];
  for (let i = 0; i < ids.length; i += MAX_SLOTS) {
    const idx = blobs.length;
    blobs.push({
      id: `blob-${idx + 1}`,
      label: idx === 0 ? "Home" : `Blob ${idx + 1}`,
      slots: ids.slice(i, i + MAX_SLOTS),
      color: colorForIndex(idx),
    });
  }
  if (blobs.length === 0) blobs.push({ id: "blob-1", label: "Home", slots: [], color: colorForIndex(0) });
  return blobs;
}

/** Place any registered module not yet sitting in a blob — new installs land on
 *  the first blob with room (else a new blob). Returns the SAME reference when
 *  nothing changed (so callers can skip a needless save).
 *  NOTE: this also re-places a module the user moved to the stash on the next
 *  full reload; persisting an explicit "stashed" set is a follow-up. */
export function ensurePlaced(layout: BlobLayout, ids: string[]): BlobLayout {
  const placed = new Set(layout.flatMap((b) => b.slots));
  const missing = ids.filter((id) => !placed.has(id));
  if (!missing.length) return layout;
  let next = layout;
  for (const id of missing) next = addModule(next, id);
  return next;
}

/** Drop unknown module ids + backfill colours (migration for older saves).
 *  `ids` = the known/registered module ids (live registry); unknown ids are
 *  dropped, so a module that was uninstalled disappears from a saved layout. */
function reconcile(layout: BlobLayout, ids: string[] = MODULES.map((m) => m.id)): BlobLayout {
  const known = new Set(ids);
  const cleaned = layout
    .map((b, i) => ({
      ...b,
      slots: b.slots.filter((s) => known.has(s)),
      color: b.color ?? colorForIndex(i),
    }))
    // an empty blob is valid only if it's the sole blob (everything stashed)
    .filter((b, _i, arr) => b.slots.length > 0 || arr.length === 1);
  return cleaned.length ? cleaned : defaultLayout(ids);
}

export async function loadLayout(ids: string[] = MODULES.map((m) => m.id)): Promise<BlobLayout> {
  try {
    const r = await fetch("/api/app-config/blob_layout");
    if (r.ok) {
      const { value } = await r.json();
      if (Array.isArray(value) && value.length) return reconcile(value as BlobLayout, ids);
    }
  } catch {
    /* fall back to default */
  }
  return defaultLayout(ids);
}

export async function saveLayout(layout: BlobLayout): Promise<void> {
  await fetch("/api/app-config/blob_layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: layout }),
  });
}

/** Modules registered but not sitting in any blob — the stash. */
export function stashedModuleIds(layout: BlobLayout, ids: string[] = MODULES.map((m) => m.id)): string[] {
  const placed = new Set(layout.flatMap((b) => b.slots));
  return ids.filter((id) => !placed.has(id));
}

/** Add a module to the layout: into the last blob with room, else a new blob. */
export function addModule(layout: BlobLayout, moduleId: string): BlobLayout {
  if (layout.some((b) => b.slots.includes(moduleId))) return layout;
  const next = layout.map((b) => ({ ...b, slots: [...b.slots] }));
  const room = next.find((b) => b.slots.length < MAX_SLOTS);
  if (room) room.slots.push(moduleId);
  else next.push({ id: newBlobId(), label: `Blob ${next.length + 1}`, slots: [moduleId], color: colorForIndex(next.length) });
  return next;
}

/** Move a module to a specific blob. No-op if the target is full. */
export function assignModule(layout: BlobLayout, moduleId: string, blobId: string): BlobLayout {
  const target = layout.find((b) => b.id === blobId);
  // Refuse to strip the module from its home if the target can't hold it.
  if (target && !target.slots.includes(moduleId) && target.slots.length >= MAX_SLOTS) return layout;
  const next = layout.map((b) => ({ ...b, slots: b.slots.filter((s) => s !== moduleId) }));
  const t = next.find((b) => b.id === blobId);
  if (t && t.slots.length < MAX_SLOTS) t.slots.push(moduleId);
  return next.filter((b, _i, arr) => b.slots.length > 0 || arr.length === 1);
}

/** Remove a module from every blob — it goes to the stash. */
export function unassignModule(layout: BlobLayout, moduleId: string): BlobLayout {
  const next = layout.map((b) => ({ ...b, slots: b.slots.filter((s) => s !== moduleId) }));
  return next.filter((b, _i, arr) => b.slots.length > 0 || arr.length === 1);
}

export function addBlob(layout: BlobLayout): BlobLayout {
  return [...layout, { id: newBlobId(), label: `Blob ${layout.length + 1}`, slots: [], color: colorForIndex(layout.length) }];
}

/**
 * Delete a blob entirely. Any modules it held become unplaced — they fall back
 * to the stash (the customize menu's holding area), draggable onto another blob.
 * Never deletes the last remaining blob (something must hold focus + the stash).
 */
export function deleteBlob(layout: BlobLayout, blobId: string): BlobLayout {
  if (layout.length <= 1) return layout;
  const next = layout.filter((b) => b.id !== blobId);
  return next.length ? next : layout;
}

export function setBlobColor(layout: BlobLayout, blobId: string, color: string): BlobLayout {
  return layout.map((b) => (b.id === blobId ? { ...b, color } : b));
}

export function renameBlob(layout: BlobLayout, blobId: string, label: string): BlobLayout {
  return layout.map((b) => (b.id === blobId ? { ...b, label } : b));
}
