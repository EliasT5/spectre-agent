"use client";

import { useState } from "react";
import { Pencil, FolderInput, Archive, ArchiveRestore, Trash2, Check, ChevronLeft } from "lucide-react";
import { Sheet } from "./Sheet";
import { type Category, type Thread, CAT_DEFAULT_COLOR } from "./types";

/**
 * Per-chat action sheet, opened from a card's kebab. Normal chats get
 * Rename / Move to… / Archive / Delete; archived chats get Unarchive / Delete.
 * Rename swaps to inline editing on the card (the parent owns that), so this
 * sheet just triggers it. Delete is a two-step confirm; it is permanent.
 */
export function ThreadActionSheet({
  thread,
  categories,
  archivedView,
  onClose,
  onStartRename,
  onMove,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  thread: Thread;
  categories: Category[];
  archivedView: boolean;
  onClose: () => void;
  onStartRename: (id: string) => void;
  onMove: (id: string, projectId: string | null) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [view, setView] = useState<"main" | "move">("main");
  const [confirmDel, setConfirmDel] = useState(false);

  const title = thread.title?.trim() || "New conversation";

  if (view === "move") {
    return (
      <Sheet title="Move to…" subtitle={title} onClose={onClose}>
        <button className="sheet-item back tap-press" onClick={() => setView("main")}>
          <ChevronLeft size={16} strokeWidth={1.8} /> Back
        </button>
        <div className="move-list">
          <button
            className="move-item tap-press"
            aria-current={!thread.project_id ? "true" : undefined}
            onClick={() => {
              onMove(thread.id, null);
              onClose();
            }}
          >
            <span className="move-item-dot none" aria-hidden />
            <span className="move-item-name">None (Uncategorized)</span>
            {!thread.project_id && <Check size={16} strokeWidth={2.2} className="move-item-check" aria-label="Current" />}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className="move-item tap-press"
              aria-current={thread.project_id === c.id ? "true" : undefined}
              onClick={() => {
                onMove(thread.id, c.id);
                onClose();
              }}
            >
              <span className="move-item-dot" style={{ background: c.color ?? CAT_DEFAULT_COLOR }} aria-hidden />
              <span className="move-item-name">{c.name}</span>
              {thread.project_id === c.id && <Check size={16} strokeWidth={2.2} className="move-item-check" aria-label="Current" />}
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="sheet-actions">
        <button
          className="sheet-item tap-press"
          onClick={() => {
            onClose();
            onStartRename(thread.id);
          }}
        >
          <Pencil size={16} strokeWidth={1.8} /> Rename
        </button>
        {!archivedView && (
          <button className="sheet-item tap-press" onClick={() => setView("move")}>
            <FolderInput size={16} strokeWidth={1.8} /> Move to…
          </button>
        )}
        {archivedView ? (
          <button
            className="sheet-item tap-press"
            onClick={() => {
              onUnarchive(thread.id);
              onClose();
            }}
          >
            <ArchiveRestore size={16} strokeWidth={1.8} /> Unarchive
          </button>
        ) : (
          <button
            className="sheet-item tap-press"
            onClick={() => {
              onArchive(thread.id);
              onClose();
            }}
          >
            <Archive size={16} strokeWidth={1.8} /> Archive
          </button>
        )}
        {confirmDel ? (
          <button
            className="sheet-item danger tap-press"
            onClick={() => {
              onDelete(thread.id);
              onClose();
            }}
          >
            <Trash2 size={16} strokeWidth={1.8} /> Confirm delete — permanent
          </button>
        ) : (
          <button className="sheet-item danger tap-press" onClick={() => setConfirmDel(true)}>
            <Trash2 size={16} strokeWidth={1.8} /> Delete
          </button>
        )}
      </div>
    </Sheet>
  );
}
