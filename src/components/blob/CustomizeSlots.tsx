"use client";

import { useState, type CSSProperties, type DragEvent } from "react";
import { useModules } from "@/lib/module-registry";
import {
  MAX_SLOTS,
  addBlob,
  assignModule,
  blobColor,
  deleteBlob,
  renameBlob,
  setBlobColor,
  stashedModuleIds,
  unassignModule,
  type BlobLayout,
} from "@/lib/blob-layout";

const STASH = "__stash__";

/**
 * The one customize console. Arrange which modules sit in which blob (drag the
 * chips between blobs, ≤10 each), recolour + rename each blob, add a blob, jump
 * to one. Modules you drag into the Stash leave every blob and wait here to be
 * dropped back. Persists via onChange (-> blob_layout in the core).
 */
export function CustomizeSlots({
  layout,
  activeId,
  onChange,
  onEnter,
}: {
  layout: BlobLayout;
  activeId: string;
  onChange: (next: BlobLayout) => void;
  onEnter: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Live module registry (seeds with static MODULES) — for chip labels.
  const modules = useModules();
  const labelOf = (id: string) => modules.find((m) => m.id === id)?.label ?? id;

  const stashed = stashedModuleIds(layout, modules.map((m) => m.id));

  const chip = (mid: string) => (
    <span
      key={mid}
      className={`cp-chip${dragId === mid ? " dragging" : ""}`}
      draggable
      onDragStart={(e: DragEvent) => {
        setDragId(mid);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", mid);
      }}
      onDragEnd={() => {
        setDragId(null);
        setOver(null);
      }}
    >
      <span className="grip" aria-hidden>⠿</span>
      {labelOf(mid)}
    </span>
  );

  const allowDrop = (target: string) => (e: DragEvent) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (over !== target) setOver(target);
  };
  const dropOnBlob = (blobId: string) => (e: DragEvent) => {
    e.preventDefault();
    if (dragId) onChange(assignModule(layout, dragId, blobId));
    setDragId(null);
    setOver(null);
  };
  const dropOnStash = (e: DragEvent) => {
    e.preventDefault();
    if (dragId) onChange(unassignModule(layout, dragId));
    setDragId(null);
    setOver(null);
  };

  return (
    <>
      <button className="customize-btn" onClick={() => setOpen((o) => !o)} aria-label="Customize blobs">
        ⊕ Blobs
      </button>

      {open && (
        <div className="customize-panel">
          <div className="cp-head">
            <span>Blobs &amp; slots</span>
            <button className="cp-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {layout.map((b, i) => {
            const color = blobColor(b, i);
            return (
              <div
                key={b.id}
                className={`cp-blob${over === b.id ? " drop-target" : ""}`}
                style={{ ["--blob-color" as keyof CSSProperties]: color } as CSSProperties}
                onDragOver={allowDrop(b.id)}
                onDragLeave={() => over === b.id && setOver(null)}
                onDrop={dropOnBlob(b.id)}
              >
                <div className="cp-blob-head">
                  <div className="cp-blob-id">
                    <label className="cp-swatch" style={{ background: color }} title="Recolour this blob" htmlFor={`swatch-${b.id}`}>
                      <input
                        id={`swatch-${b.id}`}
                        type="color"
                        value={color}
                        onChange={(e) => onChange(setBlobColor(layout, b.id, e.target.value))}
                        aria-label="Blob colour"
                      />
                    </label>
                    <input
                      className={`cp-blob-name${b.id === activeId ? " on" : ""}`}
                      defaultValue={b.label}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== b.label) onChange(renameBlob(layout, b.id, v));
                      }}
                      aria-label="Blob name"
                    />
                  </div>
                  <div className="cp-blob-actions">
                    <span className="cp-count">{b.slots.length}/{MAX_SLOTS}</span>
                    <button
                      className="cp-x"
                      title="Travel to this blob"
                      onClick={() => {
                        onEnter(b.id);
                        setOpen(false);
                      }}
                    >
                      ⤴
                    </button>
                    {layout.length > 1 && (
                      <button
                        className="cp-x cp-del"
                        title="Delete this blob — its modules return to the stash"
                        onClick={() => onChange(deleteBlob(layout, b.id))}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
                <div className="cp-slots">
                  {b.slots.length === 0 && <span className="empty-slot">drag a module here</span>}
                  {b.slots.map((mid) => chip(mid))}
                </div>
              </div>
            );
          })}

          <button className="cp-add" onClick={() => onChange(addBlob(layout))}>+ New blob</button>

          {/* Stash — modules that sit on no blob, waiting to be dragged back. */}
          <div
            className={`cp-blob${over === STASH ? " drop-target" : ""}`}
            style={{ ["--blob-color" as keyof CSSProperties]: "#6b6593" } as CSSProperties}
            onDragOver={allowDrop(STASH)}
            onDragLeave={() => over === STASH && setOver(null)}
            onDrop={dropOnStash}
          >
            <div className="cp-blob-head">
              <div className="cp-blob-id"><span className="label">Stash</span></div>
              <span className="cp-count">{stashed.length}</span>
            </div>
            <div className="cp-slots">
              {stashed.length === 0 && <span className="empty-slot">drag a module here to unassign</span>}
              {stashed.map((mid) => chip(mid))}
            </div>
          </div>

          <div className="cp-hint">Drag chips between blobs or the stash. Scroll out on the blob to see the constellation; click a blob to travel.</div>
        </div>
      )}
    </>
  );
}
