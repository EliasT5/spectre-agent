"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Search, Trash2, Plus, Sparkles, Image as ImageIcon, X } from "lucide-react";
import { TabShell, Panel, Chip, Bar, Input, Button, Fab, EmptyState } from "@/components/ui";

type MemoryItem = {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  similarity?: number;
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

export default function MemoryTab() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("");
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (cat) params.set("category", cat);
    // Recall facts AND media in one pass — a single search resurfaces both.
    const mediaParams = new URLSearchParams();
    if (q.trim()) mediaParams.set("q", q.trim());
    const [r, mr] = await Promise.all([
      fetch(`/api/memory?${params}`),
      fetch(`/api/generated/library?${mediaParams}`).catch(() => null),
    ]);
    if (r.ok) {
      const data = await r.json();
      setItems(data.items ?? []);
      setCategories(data.categories ?? []);
      setMode(data.mode ?? "");
    }
    if (mr && mr.ok) {
      const md = await mr.json();
      setMedia(md.items ?? []);
    }
    setLoading(false);
  }, [q, cat]);

  useEffect(() => {
    load();
  }, [cat]); // re-run on category change; search is on Enter

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    load();
  }

  async function del(id: string) {
    setItems((prev) => prev.filter((m) => m.id !== id));
    await fetch(`/api/memory/${id}`, { method: "DELETE" });
  }

  async function delMedia(name: string) {
    setMedia((prev) => prev.filter((m) => m.name !== name));
    setLightbox((lb) => (lb?.name === name ? null : lb));
    await fetch(`/api/generated?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  return (
    <TabShell
      eyebrow="SYSTEM · MEMORY"
      title="Memory"
      status={loading ? "recalling…" : `${items.length}${mode === "semantic" ? " by meaning" : ""}`}
      tone="ok"
    >
      {/* Hero — semantic recall console */}
      <Panel
        hud
        icon={<Brain strokeWidth={1.6} size={18} />}
        label="RECALL"
        title="Semantic search"
        aside={
          <span className="mono" style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
            {mode === "semantic" ? "BY MEANING" : "ALL"}
          </span>
        }
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
          <Search
            strokeWidth={1.6}
            size={17}
            style={{ color: "var(--color-text-muted)", flexShrink: 0 }}
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search memories by meaning…"
            style={{ flex: 1 }}
          />
          <Button onClick={load}>Search</Button>
        </div>

        {categories.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 7,
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--color-border)",
            }}
          >
            <Chip on={cat === ""} onClick={() => setCat("")}>
              all
            </Chip>
            {categories.map((c) => (
              <Chip key={c} on={cat === c} onClick={() => setCat(c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
      </Panel>

      {/* Media library — screenshots & generated images, recall-indexed */}
      {media.length > 0 && (
        <Panel
          icon={<ImageIcon strokeWidth={1.6} size={18} />}
          label="MEDIA"
          title={q.trim() ? "Matching media" : "Screenshots & images"}
          aside={
            <span className="mono" style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
              {media.length}
            </span>
          }
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
              gap: 10,
              marginTop: 4,
            }}
          >
            {media.map((m) => (
              <figure
                key={m.id}
                className="tap-press"
                onClick={() => setLightbox(m)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLightbox(m); } }}
                role="button"
                tabIndex={0}
                title={m.caption ?? m.name}
                style={{
                  margin: 0,
                  cursor: "zoom-in",
                  borderRadius: "var(--r-sm)",
                  overflow: "hidden",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                  position: "relative",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={m.url}
                  alt={m.caption ?? m.name}
                  loading="lazy"
                  style={{ width: "100%", aspectRatio: "16 / 10", objectFit: "cover", display: "block" }}
                />
                <button
                  className="del tap-press"
                  onClick={(e) => {
                    e.stopPropagation();
                    delMedia(m.name);
                  }}
                  title="Delete image"
                  aria-label="Delete image"
                  style={{ position: "absolute", top: 6, right: 6, background: "rgba(5,5,7,0.6)", borderRadius: "var(--r-sm)" }}
                >
                  <Trash2 strokeWidth={1.6} size={14} />
                </button>
                <figcaption
                  style={{
                    padding: "7px 8px",
                    fontSize: 11,
                    lineHeight: 1.35,
                    color: "var(--color-text-secondary)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.caption ?? m.name}
                  </span>
                  {typeof m.similarity === "number" && (
                    <Chip color="var(--color-success)">{(m.similarity * 100).toFixed(0)}% match</Chip>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </Panel>
      )}

      {/* Memory feed */}
      {loading ? (
        [0, 1, 2, 3].map((i) => (
          <div key={i} className="panel gradient-border" style={{ opacity: 1 - i * 0.18 }}>
            <div className="glass-fresnel" aria-hidden />
            <div className="skeleton" style={{ height: 13, width: "30%", borderRadius: "var(--r-sm)" }} />
            <div className="skeleton" style={{ height: 15, width: "88%", marginTop: 12, borderRadius: "var(--r-sm)" }} />
            <div className="skeleton" style={{ height: 15, width: "64%", marginTop: 7, borderRadius: "var(--r-sm)" }} />
            <div className="skeleton" style={{ height: 6, width: "100%", marginTop: 16, borderRadius: "var(--pill)" }} />
          </div>
        ))
      ) : items.length === 0 ? (
        <EmptyState>No memories yet. Teach Spectre something below.</EmptyState>
      ) : (
        items.map((m) => (
          <Panel key={m.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              {m.category && <Chip on>{m.category}</Chip>}
              {typeof m.similarity === "number" && (
                <Chip color="var(--color-success)">{(m.similarity * 100).toFixed(0)}% match</Chip>
              )}
              <button
                className="del tap-press"
                onClick={() => del(m.id)}
                title="Forget this"
                aria-label="Forget this memory"
                style={{ marginLeft: "auto" }}
              >
                <Trash2 strokeWidth={1.6} size={15} />
              </button>
            </div>

            <p style={{ margin: "10px 0 0", lineHeight: 1.55, color: "var(--color-text)" }}>{m.content}</p>

            {typeof m.importance === "number" && (
              <div style={{ marginTop: 14 }}>
                <div
                  className="mono"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    letterSpacing: "0.04em",
                    color: "var(--color-text-muted)",
                    marginBottom: 6,
                  }}
                >
                  <span>IMPORTANCE</span>
                  <span style={{ color: "var(--color-text-secondary)" }}>{m.importance} / 10</span>
                </div>
                <Bar value={m.importance / 10} />
              </div>
            )}
          </Panel>
        ))
      )}

      {/* Teach composer */}
      <Panel
        icon={<Sparkles strokeWidth={1.6} size={18} />}
        label="LEARN"
        title="Teach Spectre"
      >
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Teach Spectre a new fact…"
            style={{ flex: 1 }}
          />
          <Fab onClick={add} disabled={!draft.trim()} title="Add memory">
            <Plus strokeWidth={1.6} size={20} />
          </Fab>
        </div>
      </Panel>

      {/* Lightbox — enlarge a media item (position:fixed, no portal per App-Router rule) */}
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
          {(lightbox.caption || lightbox.createdAt) && (
            <div
              className="mono"
              style={{
                maxWidth: "min(1100px, 92vw)",
                fontSize: 12,
                color: "var(--color-text-secondary)",
                textAlign: "center",
                display: "flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
              }}
            >
              {lightbox.caption && <span style={{ color: "var(--color-text)" }}>{lightbox.caption}</span>}
              {lightbox.createdAt && (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {new Date(lightbox.createdAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </TabShell>
  );
}
