"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { Panel, Button, Input, Select, Field, EmptyState, ErrorState } from "@/components/ui";
import {
  tempusApi,
  formatDurationCompact,
  formatDayLabel,
  formatTimeOfDay,
  projectColor,
  type TempusEntry,
  type TempusProjectStat,
} from "@/lib/tempus";
import { fromLocalInput, iconBtn, toLocalInput } from "./shared";

type Draft = { project_id: string; description: string; start: string; end: string };

export function EntriesView({ initialProjectId = "" }: { initialProjectId?: string }) {
  const [entries, setEntries] = useState<TempusEntry[]>([]);
  const [projects, setProjects] = useState<TempusProjectStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [projectFilter, setProjectFilter] = useState(initialProjectId);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newEntry, setNewEntry] = useState<Draft>({ project_id: "", description: "", start: "", end: "" });

  const filters = useMemo(
    () => ({
      projectId: projectFilter || undefined,
      from: fromDate ? `${fromDate}T00:00:00` : undefined,
      to: toDate ? `${toDate}T23:59:59` : undefined,
      q: search.trim() || undefined,
      limit: 200,
    }),
    [projectFilter, fromDate, toDate, search],
  );

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const items = await tempusApi.listEntries(filters);
      items.sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
      setEntries(items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load entries");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    tempusApi
      .getProjects()
      .then((p) => {
        setProjects(p);
        setNewEntry((n) => ({ ...n, project_id: n.project_id || initialProjectId || p[0]?.id || "" }));
      })
      .catch(() => {});
  }, [initialProjectId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  const totalMs = useMemo(() => entries.reduce((s, e) => s + (e.duration_ms ?? 0), 0), [entries]);
  const hasFilter = !!(projectFilter || fromDate || toDate || search);

  function startEdit(e: TempusEntry) {
    setEditingId(e.id);
    setDraft({
      project_id: e.project_id ?? "",
      description: e.description ?? "",
      start: toLocalInput(e.start_time),
      end: toLocalInput(e.end_time),
    });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function saveEdit(id: string) {
    if (!draft) return;
    const start = fromLocalInput(draft.start);
    const end = fromLocalInput(draft.end);
    if (!draft.project_id || !start || !end) return;
    if (new Date(end) <= new Date(start)) {
      setErr("End time must be after start time");
      return;
    }
    setSavingId(id);
    setErr(null);
    try {
      await tempusApi.updateEntry(id, {
        project_id: draft.project_id,
        description: draft.description,
        start_time: start,
        end_time: end,
      });
      cancelEdit();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save entry");
    } finally {
      setSavingId(null);
    }
  }

  async function remove(id: string) {
    if (typeof window !== "undefined" && !window.confirm("Delete this time entry?")) return;
    setDeletingId(id);
    setErr(null);
    try {
      await tempusApi.deleteEntry(id);
      if (editingId === id) cancelEdit();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete entry");
    } finally {
      setDeletingId(null);
    }
  }

  async function create() {
    const start = fromLocalInput(newEntry.start);
    const end = fromLocalInput(newEntry.end);
    if (!newEntry.project_id || !start || !end) return;
    if (new Date(end) <= new Date(start)) {
      setErr("End time must be after start time");
      return;
    }
    setErr(null);
    try {
      await tempusApi.addManualEntry({
        project_id: newEntry.project_id,
        start_time: start,
        end_time: end,
        description: newEntry.description || undefined,
      });
      setShowCreate(false);
      setNewEntry((n) => ({ ...n, description: "", start: "", end: "" }));
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add entry");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {err && <ErrorState>{err}</ErrorState>}

      {/* Filters */}
      <Panel
        label={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        meta={<span className="mono muted" style={{ fontSize: 12 }}>{formatDurationCompact(totalMs)}</span>}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <Field label="Project">
            <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </Field>
          <Field label="Search">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Description contains…"
            />
          </Field>
          {hasFilter && (
            <Button
              variant="ghost"
              onClick={() => {
                setProjectFilter("");
                setFromDate("");
                setToDate("");
                setSearch("");
              }}
            >
              <X size={14} /> Clear
            </Button>
          )}
          <Button onClick={() => setShowCreate((v) => !v)}>
            <Plus size={14} /> {showCreate ? "Close" : "New entry"}
          </Button>
        </div>

        {showCreate && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
            <Select
              value={newEntry.project_id}
              onChange={(e) => setNewEntry({ ...newEntry, project_id: e.target.value })}
            >
              {projects.length === 0 && <option value="">No projects — create one first</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Input type="datetime-local" aria-label="Start" value={newEntry.start} onChange={(e) => setNewEntry({ ...newEntry, start: e.target.value })} />
              <Input type="datetime-local" aria-label="End" value={newEntry.end} onChange={(e) => setNewEntry({ ...newEntry, end: e.target.value })} />
            </div>
            <Input
              value={newEntry.description}
              onChange={(e) => setNewEntry({ ...newEntry, description: e.target.value })}
              placeholder="Description (optional)"
              aria-label="Description"
            />
            <Button
              variant="primary"
              disabled={!newEntry.project_id || !newEntry.start || !newEntry.end}
              onClick={create}
            >
              Add entry
            </Button>
          </div>
        )}
      </Panel>

      {/* List */}
      <Panel label="ENTRIES" title="Log">
        {loading ? (
          <EmptyState>Loading entries…</EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>{hasFilter ? "No entries match the filters." : "No entries yet."}</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {entries.map((e) => {
              const editing = editingId === e.id;
              const color = projectColor(e.project);
              if (editing && draft) {
                return (
                  <div key={e.id} style={{ padding: "12px 2px", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <Select value={draft.project_id} onChange={(ev) => setDraft({ ...draft, project_id: ev.target.value })}>
                        {!draft.project_id && <option value="">Select project…</option>}
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                      <Input value={draft.description} onChange={(ev) => setDraft({ ...draft, description: ev.target.value })} placeholder="Description" aria-label="Description" />
                      <Input type="datetime-local" aria-label="Start" value={draft.start} onChange={(ev) => setDraft({ ...draft, start: ev.target.value })} />
                      <Input type="datetime-local" aria-label="End" value={draft.end} onChange={(ev) => setDraft({ ...draft, end: ev.target.value })} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <Button variant="ghost" disabled={savingId === e.id} onClick={cancelEdit}>
                        Cancel
                      </Button>
                      <Button
                        disabled={savingId === e.id || !draft.project_id || !draft.start || !draft.end}
                        onClick={() => saveEdit(e.id)}
                      >
                        {savingId === e.id ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--color-border)" }}>
                  <span style={{ width: 4, height: 30, borderRadius: 99, background: color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
                      <span style={{ fontWeight: 600 }}>{e.project?.name ?? "—"}</span>
                      {e.description && (
                        <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          · {e.description}
                        </span>
                      )}
                    </div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {formatDayLabel(e.start_time)} · {formatTimeOfDay(e.start_time)}–{formatTimeOfDay(e.end_time)} · {e.source ?? "manual"}
                    </div>
                  </div>
                  <span className="mono" style={{ fontSize: 12, flexShrink: 0 }}>
                    {formatDurationCompact(e.duration_ms ?? 0)}
                  </span>
                  <button type="button" title="Edit" aria-label="Edit entry" onClick={() => startEdit(e)} style={iconBtn}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" title="Delete" aria-label="Delete entry" onClick={() => remove(e.id)} disabled={deletingId === e.id} style={iconBtn}>
                    <Trash2 size={14} />
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
