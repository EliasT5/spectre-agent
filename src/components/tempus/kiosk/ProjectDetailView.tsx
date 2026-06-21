"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Trash2, ListFilter } from "lucide-react";
import { Panel, StatGrid, Stat, Button, Input, EmptyState, ErrorState, Chip } from "@/components/ui";
import {
  tempusApi,
  formatDurationCompact,
  formatDayLabel,
  formatTimeOfDay,
  projectColor,
  type TempusEntry,
  type TempusProjectStat,
} from "@/lib/tempus";
import { colorSwatch, iconBtn } from "./shared";

export function ProjectDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [project, setProject] = useState<TempusProjectStat | null>(null);
  const [entries, setEntries] = useState<TempusEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, ent] = await Promise.all([
        tempusApi.getProject(id),
        tempusApi.getProjectEntries(id),
      ]);
      setProject(p);
      setEntries(ent);
      setName(p.name);
      setColor(p.color ?? "#6366f1");
      setDescription(p.description ?? "");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load project");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveEdit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await tempusApi.updateProject(id, { name: name.trim(), color, description });
      setEditing(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    if (!project) return;
    setBusy(true);
    try {
      await tempusApi.updateProject(id, { is_archived: !project.is_archived });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to archive");
    } finally {
      setBusy(false);
    }
  }

  async function removeProject() {
    if (typeof window !== "undefined" && !window.confirm("Delete this project and all its time entries?"))
      return;
    setBusy(true);
    try {
      await tempusApi.deleteProject(id);
      router.push("/kiosk/tempus/projects");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete");
      setBusy(false);
    }
  }

  async function removeEntry(entryId: string) {
    if (typeof window !== "undefined" && !window.confirm("Delete this time entry?")) return;
    setBusy(true);
    try {
      await tempusApi.deleteEntry(entryId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete entry");
    } finally {
      setBusy(false);
    }
  }

  if (err && !project) return <ErrorState>{err}</ErrorState>;
  if (!project) return <EmptyState>Loading…</EmptyState>;

  const c = projectColor(project);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {err && <ErrorState>{err}</ErrorState>}

      <Link href="/kiosk/tempus/projects" style={{ fontSize: 12, color: "var(--color-text-muted)", textDecoration: "none" }}>
        ← All projects
      </Link>

      <Panel
        label={project.is_archived ? "ARCHIVED" : "PROJECT"}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 12, height: 12, borderRadius: 99, background: c }} />
            {project.name}
          </span>
        }
        aside={
          <span style={{ display: "inline-flex", gap: 4 }}>
            <button type="button" title="Edit" aria-label="Edit project" onClick={() => setEditing((v) => !v)} style={iconBtn}>
              <Pencil size={15} />
            </button>
            <button type="button" title={project.is_archived ? "Restore" : "Archive"} aria-label="Archive project" onClick={toggleArchive} disabled={busy} style={iconBtn}>
              {project.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            </button>
            <button type="button" title="Delete" aria-label="Delete project" onClick={removeProject} disabled={busy} style={iconBtn}>
              <Trash2 size={15} />
            </button>
          </span>
        }
      >
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" aria-label="Project name" style={{ flex: 1 }} />
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Project colour" aria-label="Project colour" style={colorSwatch} />
            </div>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" aria-label="Description" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={saveEdit} disabled={busy || !name.trim()}>
                Save
              </Button>
            </div>
          </div>
        ) : project.description ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{project.description}</p>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13, opacity: 0.6 }}>No description.</p>
        )}
      </Panel>

      <StatGrid>
        <Stat n={formatDurationCompact(project.total_ms)} k="Total tracked" />
        <Stat n={String(project.entry_count)} k="Entries" />
      </StatGrid>

      <Panel
        label={`${entries.length}`}
        title="Time entries"
        aside={
          <Link href={`/kiosk/tempus/entries?projectId=${id}`} title="Open in Entries">
            <Chip><ListFilter size={12} style={{ verticalAlign: "-2px" }} /> filter</Chip>
          </Link>
        }
      >
        {entries.length === 0 ? (
          <EmptyState>No entries for this project yet.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {entries.map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--color-border)" }}>
                <span style={{ width: 4, height: 28, borderRadius: 99, background: c, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.description || "—"}
                  </div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {formatDayLabel(e.start_time)} · {formatTimeOfDay(e.start_time)}–{formatTimeOfDay(e.end_time)} · {e.source ?? "manual"}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 12, flexShrink: 0 }}>
                  {formatDurationCompact(e.duration_ms ?? 0)}
                </span>
                <button type="button" title="Delete" aria-label="Delete entry" onClick={() => removeEntry(e.id)} disabled={busy} style={iconBtn}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
