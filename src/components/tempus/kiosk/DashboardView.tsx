"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Timer, Play, Square, Clock, CalendarRange, FolderPlus } from "lucide-react";
import {
  Panel,
  StatGrid,
  Stat,
  Bar,
  Button,
  Input,
  Select,
  EmptyState,
  ErrorState,
} from "@/components/ui";
import {
  tempusApi,
  formatDuration,
  formatDurationCompact,
  formatTimeOfDay,
  projectColor,
  elapsedMs,
  localTz,
  type TempusTimer,
  type TempusProjectStat,
  type TempusSummary,
  type TempusEntry,
} from "@/lib/tempus";

export function DashboardView() {
  const [timer, setTimer] = useState<TempusTimer>({ active: false });
  const [projects, setProjects] = useState<TempusProjectStat[]>([]);
  const [today, setToday] = useState<TempusSummary | null>(null);
  const [week, setWeek] = useState<TempusSummary | null>(null);
  const [recent, setRecent] = useState<TempusEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");
  const [desc, setDesc] = useState("");
  const [, tick] = useState(0);
  const tz = useMemo(() => localTz(), []);

  const refresh = useCallback(async () => {
    try {
      const [t, p, td, wk, ent] = await Promise.all([
        tempusApi.getTimer(),
        tempusApi.getProjects(),
        tempusApi.getSummary("today", tz),
        tempusApi.getSummary("week", tz),
        tempusApi.listEntries({ limit: 6 }),
      ]);
      setTimer(t);
      setProjects(p);
      setToday(td);
      setWeek(wk);
      setRecent(ent);
      setPick((cur) => cur || p[0]?.id || "");
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load Tempus data");
    }
  }, [tz]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // 1Hz tick while the timer runs so the elapsed readout climbs live.
  const running = timer.active;
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!running) {
      if (tickRef.current) clearInterval(tickRef.current);
      return;
    }
    tickRef.current = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
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

  const todayMs = today?.total_ms ?? 0;
  const weekMs = week?.total_ms ?? 0;
  const weekMax = Math.max(1, ...(week?.by_project ?? []).map((b) => b.total_ms));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {err && <ErrorState>{err}</ErrorState>}

      {/* Timer */}
      <Panel
        icon={<Timer strokeWidth={1.6} />}
        label={timer.active ? "RUNNING" : "TIMER"}
        title={timer.active ? "Session in progress" : "Track a session"}
        hud
      >
        {timer.active ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 99,
                  background: projectColor(timer.project),
                  boxShadow: "var(--glow-sm)",
                }}
              />
              <span style={{ fontWeight: 600 }}>{timer.project.name}</span>
              {timer.description ? (
                <span className="muted" style={{ fontSize: 13 }}>
                  · {timer.description}
                </span>
              ) : null}
            </div>
            <div className="mono" style={{ fontSize: 46, lineHeight: 1, letterSpacing: ".02em" }}>
              {formatDuration(elapsedMs(timer))}
            </div>
            <Button variant="danger" disabled={busy} onClick={() => act(() => tempusApi.stop())}>
              <Square size={15} strokeWidth={2} /> Stop &amp; save session
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState>
            <p style={{ margin: 0 }}>No projects yet.</p>
            <Link href="/kiosk/tempus/projects" className="tap-press" style={linkBtn}>
              <FolderPlus size={15} /> Create your first project
            </Link>
          </EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Select value={pick} onChange={(e) => setPick(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="What are you working on? (optional)"
              aria-label="Session description"
              onKeyDown={(e) => {
                if (e.key === "Enter" && pick && !busy)
                  act(async () => {
                    await tempusApi.start(pick, desc || undefined);
                    setDesc("");
                  });
              }}
            />
            <Button
              variant="primary"
              disabled={busy || !pick}
              onClick={() =>
                act(async () => {
                  await tempusApi.start(pick, desc || undefined);
                  setDesc("");
                })
              }
            >
              <Play size={15} strokeWidth={2} /> Start
            </Button>
          </div>
        )}
      </Panel>

      {/* Today / week totals */}
      <StatGrid>
        <Stat n={formatDurationCompact(todayMs)} k="Today" />
        <Stat n={formatDurationCompact(weekMs)} k="This week" />
      </StatGrid>

      {/* This week, by project */}
      <Panel icon={<CalendarRange strokeWidth={1.6} />} label="THIS WEEK" title="By project">
        {!week || week.by_project.length === 0 ? (
          <EmptyState>No time tracked this week.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {week.by_project.slice(0, 8).map((b) => (
              <div key={b.project_id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--color-text-secondary)" }}>{b.project_name || "—"}</span>
                  <span className="mono muted">{formatDurationCompact(b.total_ms)}</span>
                </div>
                <Bar value={b.total_ms / weekMax} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Recent sessions */}
      <Panel icon={<Clock strokeWidth={1.6} />} label={`${recent.length}`} title="Recent sessions">
        {recent.length === 0 ? (
          <EmptyState>No sessions yet.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recent.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 2px",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    background: projectColor(e.project),
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{e.project?.name ?? "—"}</div>
                  {e.description ? (
                    <div
                      className="muted"
                      style={{
                        fontSize: 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.description}
                    </div>
                  ) : null}
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {formatTimeOfDay(e.start_time)}
                    {e.end_time ? ` – ${formatTimeOfDay(e.end_time)}` : ""}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 12, flexShrink: 0 }}>
                  {formatDurationCompact(e.duration_ms ?? 0)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Manage and filter all entries in the{" "}
          <Link href="/kiosk/tempus/entries" style={{ color: "var(--color-accent)" }}>
            Entries
          </Link>{" "}
          tab.
        </p>
      </Panel>
    </div>
  );
}

const linkBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  marginTop: 10,
  padding: "9px 14px",
  borderRadius: "var(--r, 12px)",
  border: "1px solid var(--color-accent, rgba(126,237,255,0.4))",
  background: "rgba(99,102,241,0.16)",
  color: "var(--color-text)",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
} as const;
