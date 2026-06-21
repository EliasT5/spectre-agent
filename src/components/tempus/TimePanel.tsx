"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, Row, Chip } from "@/components/ui";
import { Timer, Play, Square, Plus, FolderOpen, Pencil, Trash2, Sparkles } from "lucide-react";
import { Btn, fieldStyle, ErrorNote } from "./controls";
import {
  tempusApi,
  formatDuration,
  formatDurationCompact,
  formatTimeOfDay,
  formatDayLabel,
  projectColor,
  elapsedMs,
  localTz,
  type TempusTimer,
  type TempusProjectStat,
  type TempusSummary,
  type TempusEntry,
} from "@/lib/tempus";

export function TimePanel({ onTimer }: { onTimer?: (t: TempusTimer) => void }) {
  const [timer, setTimer] = useState<TempusTimer>({ active: false });
  const [projects, setProjects] = useState<TempusProjectStat[]>([]);
  const [today, setToday] = useState<TempusSummary | null>(null);
  const [week, setWeek] = useState<TempusSummary | null>(null);
  const [entries, setEntries] = useState<TempusEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");
  const [desc, setDesc] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [, tick] = useState(0);
  const tz = useMemo(() => localTz(), []);

  const refresh = useCallback(async () => {
    try {
      const [t, p, td, wk, ent] = await Promise.all([
        tempusApi.getTimer(),
        tempusApi.getProjects(),
        tempusApi.getSummary("today", tz),
        tempusApi.getSummary("week", tz),
        tempusApi.listEntries({ limit: 30 }),
      ]);
      setTimer(t);
      onTimer?.(t);
      setProjects(p);
      setToday(td);
      setWeek(wk);
      setEntries(ent);
      setErr(null);
      setPick((cur) => cur || p[0]?.id || "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [tz, onTimer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const running = timer.active;
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!running) {
      if (ref.current) clearInterval(ref.current);
      return;
    }
    ref.current = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      if (ref.current) clearInterval(ref.current);
    };
  }, [running]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ErrorNote error={err} />

      {/* Timer */}
      <Panel icon={<Timer strokeWidth={1.6} />} label={timer.active ? "RUNNING" : "TIMER"} title="Track a session" hud>
        {timer.active ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: 99, background: projectColor(timer.project), boxShadow: "var(--glow-sm)" }} />
              <span style={{ fontWeight: 600 }}>{timer.project.name}</span>
              {timer.description ? <span className="muted" style={{ fontSize: 13 }}>· {timer.description}</span> : null}
            </div>
            <div className="mono" style={{ fontSize: 46, lineHeight: 1, letterSpacing: ".02em" }}>{formatDuration(elapsedMs(timer))}</div>
            <Btn variant="danger" disabled={busy} onClick={() => act(() => tempusApi.stop())}>
              <Square size={15} strokeWidth={2} /> Stop & save session
            </Btn>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {projects.length === 0 ? (
              <span className="muted">Create a project below to start tracking.</span>
            ) : (
              <>
                <select value={pick} onChange={(e) => setPick(e.target.value)} style={fieldStyle}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What are you working on? (optional)" aria-label="Session description" style={fieldStyle} />
                <Btn variant="primary" disabled={busy || !pick} onClick={() => act(async () => { await tempusApi.start(pick, desc || undefined); setDesc(""); })}>
                  <Play size={15} strokeWidth={2} /> Start
                </Btn>
              </>
            )}
          </div>
        )}
      </Panel>

      {/* Summaries */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SummaryPanel label="TODAY" summary={today} />
        <SummaryPanel label="THIS WEEK" summary={week} />
      </div>

      {/* Recent sessions */}
      <Panel icon={<Timer strokeWidth={1.6} />} label={`${entries.length}`} title="Recent sessions">
        {entries.length === 0 ? (
          <span className="muted">No sessions yet.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {entries.map((e) => (
              <SessionRow key={e.id} entry={e} busy={busy} onSave={(d) => act(() => tempusApi.updateEntry(e.id, { description: d }))} onDelete={() => act(() => tempusApi.deleteEntry(e.id))} />
            ))}
          </div>
        )}
        <p className="muted" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5 }}>
          <Sparkles size={12} style={{ verticalAlign: "-2px" }} /> Coming next: import an Excel sheet for Spectre to read, and have Spectre summarize a watched session for you.
        </p>
      </Panel>

      {/* Manual entry */}
      <ManualEntry projects={projects} busy={busy} onAdd={(p) => act(() => tempusApi.addManualEntry(p))} />

      {/* Projects */}
      <Panel icon={<FolderOpen strokeWidth={1.6} />} label={`${projects.length}`} title="Projects">
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New project name" aria-label="New project name" style={{ ...fieldStyle, flex: 1 }} />
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} title="Project colour" aria-label="Project colour" style={{ width: 44, height: 40, borderRadius: "var(--r)", border: "1px solid var(--color-border)", background: "var(--color-surface)", cursor: "pointer" }} />
          <Btn disabled={busy || !newName.trim()} onClick={() => act(async () => { await tempusApi.createProject(newName.trim(), { color: newColor }); setNewName(""); })}>
            <Plus size={15} strokeWidth={2} /> Add
          </Btn>
        </div>
        {projects.length === 0 ? (
          <span className="muted">No projects yet.</span>
        ) : (
          projects.map((p) => (
            <Row key={p.id} label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: projectColor(p) }} />
                {p.name}
              </span>
            }>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                <span className="mono muted" style={{ fontSize: 12 }}>{formatDurationCompact(p.total_ms)}</span>
                <Chip>{p.entry_count}</Chip>
              </span>
            </Row>
          ))
        )}
      </Panel>
    </div>
  );
}

function SummaryPanel({ label, summary }: { label: string; summary: TempusSummary | null }) {
  const total = summary?.total_ms ?? 0;
  const max = Math.max(1, ...(summary?.by_project ?? []).map((b) => b.total_ms));
  return (
    <Panel label={label} title={formatDurationCompact(total)}>
      {!summary || summary.by_project.length === 0 ? (
        <span className="muted" style={{ fontSize: 13 }}>No time tracked.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {summary.by_project.slice(0, 6).map((b) => (
            <div key={b.project_id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "var(--color-text-secondary)" }}>{b.project_name || "—"}</span>
                <span className="mono muted">{formatDurationCompact(b.total_ms)}</span>
              </div>
              <div style={{ height: 5, borderRadius: 99, background: "var(--color-border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(b.total_ms / max) * 100}%`, background: b.color ?? "#6366f1", borderRadius: 99 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function SessionRow({ entry, busy, onSave, onDelete }: { entry: TempusEntry; busy: boolean; onSave: (d: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.description ?? "");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderBottom: "1px solid var(--color-border)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: projectColor(entry.project), flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--color-text)", display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ fontWeight: 600 }}>{entry.project?.name ?? "—"}</span>
          {editing ? (
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onSave(draft); setEditing(false); } }} aria-label="Edit description" style={{ ...fieldStyle, padding: "4px 8px", fontSize: 13 }} />
          ) : (
            <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.description || "—"}</span>
          )}
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>{formatDayLabel(entry.start_time)} · {formatTimeOfDay(entry.start_time)}–{formatTimeOfDay(entry.end_time)} · {entry.source ?? "timer"}</div>
      </div>
      <span className="mono" style={{ fontSize: 12, flexShrink: 0 }}>{formatDurationCompact(entry.duration_ms ?? 0)}</span>
      {editing ? (
        <Btn disabled={busy} onClick={() => { onSave(draft); setEditing(false); }}>save</Btn>
      ) : (
        <button type="button" title="Edit description" onClick={() => setEditing(true)} style={iconBtn}><Pencil size={14} /></button>
      )}
      <button type="button" title="Delete" onClick={onDelete} disabled={busy} style={iconBtn}><Trash2 size={14} /></button>
    </div>
  );
}

function ManualEntry({ projects, busy, onAdd }: { projects: TempusProjectStat[]; busy: boolean; onAdd: (p: { project_id: string; start_time: string; end_time: string; description?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [pid, setPid] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [d, setD] = useState("");
  useEffect(() => { setPid((c) => c || projects[0]?.id || ""); }, [projects]);
  const valid = pid && start && end;
  return (
    <Panel icon={<Plus strokeWidth={1.6} />} label="MANUAL" title="Add a past session" aside={<Btn onClick={() => setOpen((o) => !o)}>{open ? "close" : "open"}</Btn>}>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={fieldStyle}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time" style={fieldStyle} />
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End time" style={fieldStyle} />
          </div>
          <input value={d} onChange={(e) => setD(e.target.value)} placeholder="Description (optional)" aria-label="Description" style={fieldStyle} />
          <Btn variant="primary" disabled={busy || !valid} onClick={() => { onAdd({ project_id: pid, start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), description: d || undefined }); setStart(""); setEnd(""); setD(""); }}>Add entry</Btn>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 13 }}>Log time you didn&apos;t track live.</span>
      )}
    </Panel>
  );
}

const iconBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", padding: 4, display: "inline-flex" };
