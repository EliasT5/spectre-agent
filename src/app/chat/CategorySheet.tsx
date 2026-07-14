"use client";

import { useState } from "react";
import { Pencil, Trash2, Check, Plus } from "lucide-react";
import { Sheet } from "./Sheet";
import { type Category, CAT_SWATCHES, CAT_DEFAULT_COLOR } from "./types";

/**
 * The category manager. Lists existing categories (edit / two-step delete) above
 * a create/edit form: name, a "what belongs here" description (stored now for a
 * future auto-classifier), and a color swatch. Deleting a category re-homes its
 * chats to Uncategorized on the server, so nothing is lost.
 */
export function CategorySheet({
  categories,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  categories: Category[];
  onCreate: (v: { name: string; description: string; color: string }) => Promise<void> | void;
  onUpdate: (id: string, v: { name: string; description: string; color: string }) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(CAT_DEFAULT_COLOR);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function resetForm() {
    setEditId(null);
    setName("");
    setDescription("");
    setColor(CAT_DEFAULT_COLOR);
  }

  function startEdit(c: Category) {
    setConfirmDel(null);
    setEditId(c.id);
    setName(c.name);
    setDescription(c.description ?? "");
    setColor(c.color ?? CAT_DEFAULT_COLOR);
  }

  async function submit() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      if (editId) await onUpdate(editId, { name: n, description: description.trim(), color });
      else await onCreate({ name: n, description: description.trim(), color });
      resetForm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Categories" subtitle="Group your chats. Each category's description tells Spectre what belongs in it." onClose={onClose}>
      {categories.length > 0 && (
        <div className="cat-list">
          {categories.map((c) => (
            <div key={c.id} className="cat-row">
              <span className="cat-row-dot" style={{ background: c.color ?? CAT_DEFAULT_COLOR }} aria-hidden />
              <div className="cat-row-body">
                <div className="cat-row-name">{c.name}</div>
                {c.description && <div className="cat-row-desc">{c.description}</div>}
              </div>
              <button className="cat-row-btn tap-press" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`}>
                <Pencil size={14} strokeWidth={1.8} />
              </button>
              {confirmDel === c.id ? (
                <button
                  className="cat-row-btn danger confirm tap-press"
                  onClick={async () => {
                    await onDelete(c.id);
                    setConfirmDel(null);
                    if (editId === c.id) resetForm();
                  }}
                >
                  Confirm
                </button>
              ) : (
                <button
                  className="cat-row-btn danger tap-press"
                  onClick={() => setConfirmDel(c.id)}
                  aria-label={`Delete ${c.name}`}
                >
                  <Trash2 size={14} strokeWidth={1.8} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="cat-form">
        <div className="cat-form-label">{editId ? "Edit category" : "New category"}</div>
        <input
          className="cat-input"
          placeholder="Name — e.g. Work"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <textarea
          className="cat-input cat-textarea"
          placeholder="What belongs here? Spectre sorts matching chats into this category."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={280}
        />
        <div className="cat-swatches">
          {CAT_SWATCHES.map((s) => (
            <button
              key={s}
              type="button"
              className={`cat-swatch tap-press${color === s ? " sel" : ""}`}
              style={{ background: s }}
              onClick={() => setColor(s)}
              aria-label={`Colour ${s}`}
              aria-pressed={color === s}
            >
              {color === s && <Check size={12} strokeWidth={3} />}
            </button>
          ))}
        </div>
        <div className="cat-form-actions">
          {editId && (
            <button className="btn ghost tap-press" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button className="btn tap-press" onClick={submit} disabled={!name.trim() || busy}>
            {editId ? (
              "Save"
            ) : (
              <>
                <Plus size={14} strokeWidth={2} /> Add category
              </>
            )}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
