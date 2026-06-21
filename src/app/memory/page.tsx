"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  Search,
  Trash2,
  Plus,
  Pencil,
  Check,
  X,
  Loader2,
  AlertTriangle,
  BookOpen,
  Sparkles,
  Wrench,
  Image as ImageIcon,
} from "lucide-react";
import Link from "next/link";
import "./memory.css";

type MemoryItem = {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  similarity?: number;
  created_at?: string;
};

type MediaItem = {
  id: string;
  name: string;
  url: string;
  kind: string;
  caption: string | null;
  createdAt: string;
  similarity?: number;
};

// Sub-nav tab type — controls which pane is rendered
type SubTab = "memory" | "notes" | "soul" | "skills" | "library";

const SUB_NAV: Array<{ id: SubTab; label: string; icon: typeof Brain; href?: string }> = [
  { id: "memory",  label: "Memory",  icon: Brain },
  { id: "notes",   label: "Notes",   icon: BookOpen },
  { id: "soul",    label: "Soul",    icon: Sparkles },
  { id: "skills",  label: "Skills",  icon: Wrench },
  { id: "library", label: "Library", icon: ImageIcon, href: "/library" },
];

export default function MemoryTab() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [activeTab, setActiveTab] = useState<SubTab>("memory");

  // Debounce search input (220ms, same as Jerome monolith)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(q), 220);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    if (cat) params.set("category", cat);
    const mediaParams = new URLSearchParams();
    if (debouncedQ.trim()) mediaParams.set("q", debouncedQ.trim());
    const [r, mr] = await Promise.all([
      fetch(`/api/memory?${params}`),
      fetch(`/api/generated/library?${mediaParams}`).catch(() => null),
    ]);
    if (r.ok) {
      const data = await r.json();
      setItems(data.items ?? []);
      setCategories(data.categories ?? []);
      setMode(data.mode ?? "");
    } else {
      setError(`Couldn't load memories (${r.status}).`);
    }
    if (mr && mr.ok) {
      const md = await mr.json();
      setMedia(md.items ?? []);
    }
    setLoading(false);
  }, [debouncedQ, cat]);

  useEffect(() => {
    load();
  }, [cat, debouncedQ, load]);

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    setShowForm(false);
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    load();
  }

  async function del(id: string) {
    if (!confirm("Delete this memory?")) return;
    setItems((prev) => prev.filter((m) => m.id !== id));
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
  }

  async function delMedia(name: string) {
    setMedia((prev) => prev.filter((m) => m.name !== name));
    setLightbox((lb) => (lb?.name === name ? null : lb));
    await fetch(`/api/generated?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async function saveEdit(id: string, content: string) {
    const res = await fetch(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      setError(`Failed to update (${res.status}).`);
      return false;
    }
    setEditingId(null);
    await load();
    return true;
  }

  const memCount = items.length;
  const subtitle = loading
    ? "recalling…"
    : memCount > 0
    ? `${memCount}${mode === "semantic" ? " by meaning" : ""} memor${memCount === 1 ? "y" : "ies"}`
    : "What Spectre knows about you";

  return (
    <div className="mem-page">
      <div className="mem-col">
        {/* ── Header ── */}
        <header className="mem-header">
          <div className="mem-header-titles">
            <span className="eyebrow">MEMORY · TOOLS</span>
            <h1 className="mem-title">Memory</h1>
            <p className="mem-count">{subtitle}</p>
          </div>
          <button
            type="button"
            className="mem-fab"
            aria-label={showForm ? "Cancel" : "Add memory"}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? <X size={20} /> : <Plus size={20} />}
          </button>
        </header>

        <div className="mem-rule" aria-hidden />

        {/* ── Sub-nav pills ── */}
        <nav className="mem-subnav" aria-label="Memory sections">
          {SUB_NAV.map(({ id, label, icon: Icon, href }) => {
            const isActive = activeTab === id;
            if (href) {
              return (
                <Link
                  key={id}
                  href={href}
                  className={`mem-nav-pill${isActive ? " active" : ""}`}
                >
                  <Icon size={13} strokeWidth={1.8} aria-hidden />
                  {label}
                </Link>
              );
            }
            return (
              <button
                key={id}
                type="button"
                className={`mem-nav-pill${isActive ? " active" : ""}`}
                onClick={() => setActiveTab(id)}
              >
                <Icon size={13} strokeWidth={1.8} aria-hidden />
                {label}
              </button>
            );
          })}
        </nav>

        {/* ── Body (only memory pane has real backend) ── */}
        {activeTab === "memory" && (
          <div className="mem-body">
            {/* Add-memory form */}
            {showForm && (
              <AddMemoryForm
                draft={draft}
                setDraft={setDraft}
                onCancel={() => setShowForm(false)}
                onSubmit={add}
              />
            )}

            {/* Search bar */}
            <label className="mem-search">
              <Search className="mem-search-icon" size={16} strokeWidth={1.6} aria-hidden />
              <input
                className="mem-search-input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search memories…"
                type="search"
                autoComplete="off"
                autoCorrect="off"
              />
              {q && (
                <button
                  type="button"
                  className="mem-search-clear"
                  aria-label="Clear search"
                  onClick={() => { setQ(""); setDebouncedQ(""); }}
                >
                  <X size={14} strokeWidth={1.8} />
                </button>
              )}
            </label>

            {/* Category filter pills */}
            {categories.length > 0 && (
              <div className="mem-filters" role="group" aria-label="Filter by category">
                <button
                  type="button"
                  className={`mem-filter-pill${cat === "" ? " active" : ""}`}
                  onClick={() => setCat("")}
                >
                  ALL
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`mem-filter-pill${cat === c ? " active" : ""}`}
                    onClick={() => setCat(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="mem-error" role="alert">
                <AlertTriangle size={14} strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
                <span className="mem-error-text">{error}</span>
                <button type="button" className="mem-error-retry" onClick={load}>
                  Retry
                </button>
              </div>
            )}

            {/* Memory list */}
            <div className="mem-list">
              {loading && items.length === 0 && (
                <>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="mem-skeleton-card" aria-hidden>
                      <div className="skeleton" style={{ height: 12, width: "35%", borderRadius: "var(--r-sm)" }} />
                      <div className="skeleton" style={{ height: 14, width: "88%" }} />
                      <div className="skeleton" style={{ height: 14, width: "64%" }} />
                      <div className="skeleton" style={{ height: 5, width: "100%", borderRadius: 999 }} />
                    </div>
                  ))}
                </>
              )}

              {!loading && items.length === 0 && !error && (
                <div className="mem-empty">
                  <div className="mem-empty-orb">
                    <Brain size={28} strokeWidth={1.6} />
                  </div>
                  <p className="mem-empty-text">
                    {debouncedQ || cat
                      ? "Nothing matched. Tweak your search."
                      : "No memories yet. Add the first one."}
                  </p>
                </div>
              )}

              {items.map((m) => (
                <MemoryCard
                  key={m.id}
                  item={m}
                  editing={editingId === m.id}
                  onEdit={() => setEditingId(m.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSave={(content) => saveEdit(m.id, content)}
                  onDelete={() => del(m.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Stub panes for NOTES / SOUL / SKILLS */}
        {(activeTab === "notes" || activeTab === "soul" || activeTab === "skills") && (
          <div className="mem-body">
            <div className="mem-empty">
              <div className="mem-empty-orb">
                {activeTab === "notes" && <BookOpen size={28} strokeWidth={1.6} />}
                {activeTab === "soul" && <Sparkles size={28} strokeWidth={1.6} />}
                {activeTab === "skills" && <Wrench size={28} strokeWidth={1.6} />}
              </div>
              <p className="mem-empty-text" style={{ textTransform: "capitalize" }}>
                {activeTab === "notes" ? "Notes coming soon." : activeTab === "soul" ? "Soul files live in /spectre-core/soul/." : "Skills live in /spectre-core/skills/."}
              </p>
            </div>
          </div>
        )}

        {/* Lightbox — no portal (App-Router rule) */}
        {lightbox && (
          <div
            role="presentation"
            onClick={(e) => e.target === e.currentTarget && setLightbox(null)}
            onKeyDown={(e) => e.key === "Escape" && setLightbox(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              background: "rgba(5,5,7,0.86)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              gap: 14,
            }}
          >
            <button
              onClick={() => setLightbox(null)}
              aria-label="Close"
              className="tap-press"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--r-sm)",
                padding: 8,
                color: "var(--color-text)",
                cursor: "pointer",
              }}
            >
              <X strokeWidth={1.7} size={20} />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt={lightbox.caption ?? lightbox.name}
              style={{
                maxWidth: "min(1100px, 92vw)",
                maxHeight: "78vh",
                objectFit: "contain",
                borderRadius: "var(--r)",
                border: "1px solid var(--color-border)",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Add-memory form ─────────────────────────────────────────────────────── */

function AddMemoryForm({
  draft,
  setDraft,
  onCancel,
  onSubmit,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="mem-add-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        setSubmitting(true);
        await onSubmit();
        setSubmitting(false);
      }}
    >
      <label className="mem-add-label">
        <span className="mem-add-sublabel">Content</span>
        <textarea
          className="mem-add-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Something Spectre should remember about you…"
          autoFocus
        />
      </label>
      <div className="mem-add-row">
        <div className="mem-add-actions">
          <button type="button" className="mem-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="mem-add-submit"
            disabled={!draft.trim() || submitting}
          >
            {submitting ? (
              <Loader2 size={13} className="spin-icon" />
            ) : (
              <Plus size={13} />
            )}
            Remember
          </button>
        </div>
      </div>
    </form>
  );
}

/* ── Memory card ─────────────────────────────────────────────────────────── */

function MemoryCard({
  item,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  item: MemoryItem;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (content: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(item.content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) setDraft(item.content);
  }, [editing, item.content]);

  const importancePct = typeof item.importance === "number"
    ? Math.round((item.importance / 10) * 100)
    : null;

  const categoryLabel = item.category
    ? item.category.toUpperCase()
    : "MEMORY";

  const dateLabel = item.created_at
    ? new Date(item.created_at).toLocaleDateString("de-AT", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <article className="mem-card">
      {/* Top row: eyebrow + action icons */}
      <div className="mem-card-top">
        <div className="mem-card-meta">
          <span className="mem-card-eyebrow">{categoryLabel}</span>
          {dateLabel && (
            <>
              <span className="mem-card-eyebrow-sep" aria-hidden>·</span>
              <span className="mem-card-eyebrow">{dateLabel}</span>
            </>
          )}
          {typeof item.similarity === "number" && (
            <span className="mem-sim-badge">
              {(item.similarity * 100).toFixed(0)}% match
            </span>
          )}
        </div>

        <div className="mem-card-actions">
          {!editing ? (
            <>
              <button
                type="button"
                className="mem-icon-btn"
                aria-label="Edit memory"
                onClick={onEdit}
              >
                <Pencil size={14} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="mem-icon-btn danger"
                aria-label="Delete memory"
                onClick={onDelete}
              >
                <Trash2 size={14} strokeWidth={1.7} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="mem-icon-btn"
                aria-label="Cancel edit"
                onClick={onCancelEdit}
              >
                <X size={14} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="mem-icon-btn"
                aria-label="Save edit"
                onClick={async () => {
                  setSaving(true);
                  await onSave(draft);
                  setSaving(false);
                }}
              >
                {saving ? (
                  <Loader2 size={14} className="spin-icon" />
                ) : (
                  <Check size={14} strokeWidth={1.7} />
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Card body */}
      {editing ? (
        <textarea
          className="mem-card-edit-area"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          autoFocus
        />
      ) : (
        <p className="mem-card-body">{item.content}</p>
      )}

      {/* Weight meter */}
      {importancePct !== null && (
        <div className="mem-weight-row">
          <span className="mem-weight-label">WEIGHT {item.importance}/10</span>
          <div className="mem-weight-track" aria-hidden>
            <div
              className="mem-weight-fill"
              style={{ width: `${importancePct}%` }}
            />
          </div>
        </div>
      )}
    </article>
  );
}
