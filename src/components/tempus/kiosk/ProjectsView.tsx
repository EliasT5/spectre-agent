"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, FolderOpen, Plus } from "lucide-react";
import { Panel, Button, Input, EmptyState, ErrorState, Chip } from "@/components/ui";
import {
  tempusApi,
  formatDurationCompact,
  projectColor,
  type TempusProjectStat,
} from "@/lib/tempus";
import { colorSwatch, iconBtn } from "./shared";

export function ProjectsView() {
  const [items, setItems] = useState<TempusProjectStat[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await tempusApi.getProjects(includeArchived));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load projects");
    }
  }, [includeArchived]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    const n = name.trim();
    if (!n || creating) return;
    setCreating(true);
    try {
      await tempusApi.createProject(n, { color });
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function toggleArchive(p: TempusProjectStat) {
    setBusyId(p.id);
    try {
      await tempusApi.updateProject(p.id, { is_archived: !p.is_archived });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to archive");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {err && <ErrorState>{err}</ErrorState>}

      {/* Create */}
      <Panel icon={<Plus strokeWidth={1.6} />} label="NEW" title="Add a project">
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Project name"
            aria-label="New project name"
            style={{ flex: 1 }}
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            title="Project colour"
            aria-label="Project colour"
            style={colorSwatch}
          />
          <Button disabled={creating || !name.trim()} onClick={create}>
            <Plus size={15} strokeWidth={2} /> Add
          </Button>
        </div>
      </Panel>

      {/* List */}
      <Panel
        icon={<FolderOpen strokeWidth={1.6} />}
        label={items ? `${items.length}` : "…"}
        title="Projects"
        aside={
          <Chip on={includeArchived} onClick={() => setIncludeArchived((v) => !v)} title="Toggle archived">
            {includeArchived ? "incl. archived" : "active only"}
          </Chip>
        }
      >
        {items === null ? (
          <EmptyState>Loading…</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState>No projects yet — add one above to start tracking.</EmptyState>
        ) : (
          <div style={grid}>
            {items.map((p) => {
              const color = projectColor(p);
              const isBusy = busyId === p.id;
              return (
                <div key={p.id} style={{ ...card, opacity: p.is_archived ? 0.6 : 1 }}>
                  <span style={{ ...cardBar, background: color }} aria-hidden />
                  <Link href={`/kiosk/tempus/projects/${p.id}`} style={cardLink}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span
                        style={{ width: 10, height: 10, borderRadius: 99, background: color, flexShrink: 0 }}
                      />
                      <span style={{ fontWeight: 600, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </span>
                      {p.is_archived && (
                        <Chip>archived</Chip>
                      )}
                    </div>
                    {p.description ? (
                      <p className="muted" style={{ margin: "8px 0 0", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.description}
                      </p>
                    ) : null}
                    <div style={cardFoot}>
                      <span className="mono muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>
                        {p.entry_count} entries
                      </span>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 600, color }}>
                        {formatDurationCompact(p.total_ms)}
                      </span>
                    </div>
                  </Link>
                  <button
                    type="button"
                    title={p.is_archived ? "Restore" : "Archive"}
                    aria-label={p.is_archived ? "Restore project" : "Archive project"}
                    onClick={() => toggleArchive(p)}
                    disabled={isBusy}
                    style={{ ...iconBtn, position: "absolute", top: 8, right: 8 }}
                  >
                    {p.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: 12,
} as const;

const card = {
  position: "relative",
  borderRadius: "var(--r, 14px)",
  border: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  overflow: "hidden",
} as const;

const cardBar = { display: "block", height: 4, width: "100%" } as const;
const cardLink = { display: "block", padding: 14, textDecoration: "none", color: "var(--color-text)" } as const;
const cardFoot = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginTop: 12,
  paddingTop: 10,
  borderTop: "1px solid var(--color-border)",
} as const;
