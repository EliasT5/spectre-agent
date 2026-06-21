"use client";

import "./tempus.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Timer,
  Play,
  Square,
  Clock,
  Hash,
  CalendarClock,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
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

// ── helpers ──────────────────────────────────────────────────────────────────

function todayLabel(): string {
  return new Date().toLocaleDateString("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ── subcomponents ─────────────────────────────────────────────────────────────

function TimerCard({
  timer,
  projects,
  busy,
  onStart,
  onStop,
}: {
  timer: TempusTimer;
  projects: TempusProjectStat[];
  busy: boolean;
  onStart: (projectId: string, description: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [pick, setPick] = useState("");
  const [desc, setDesc] = useState("");
  const [localBusy, setLocalBusy] = useState(false);

  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActive = timer.active;

  useEffect(() => {
    if (!isActive) {
      if (tickRef.current) clearInterval(tickRef.current);
      return;
    }
    setNow(Date.now());
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [isActive]);

  // auto-select first project
  useEffect(() => {
    setPick((cur) => cur || projects[0]?.id || "");
  }, [projects]);

  const elapsed = useMemo(() => {
    if (!timer.active) return 0;
    return elapsedMs(timer, now);
  }, [timer, now]);

  async function handleStart() {
    if (!pick || localBusy || busy) return;
    setLocalBusy(true);
    try {
      await onStart(pick, desc.trim());
      setDesc("");
    } finally {
      setLocalBusy(false);
    }
  }

  async function handleStop() {
    if (localBusy || busy) return;
    setLocalBusy(true);
    try {
      await onStop();
    } finally {
      setLocalBusy(false);
    }
  }

  if (timer.active) {
    const color = projectColor(timer.project);
    return (
      <div className="tempus-card" style={{ borderColor: `${color}44` }}>
        <div className="timer-active-head">
          <span
            className="timer-active-dot"
            style={{ background: color }}
          />
          <span className="timer-active-project">{timer.project.name}</span>
          {timer.description && (
            <span className="timer-active-desc">· {timer.description}</span>
          )}
        </div>
        <div className="timer-active-elapsed">{formatDuration(elapsed)}</div>
        <button
          type="button"
          className="timer-btn-stop"
          disabled={localBusy || busy}
          onClick={handleStop}
        >
          <Square size={15} strokeWidth={2} />
          Stop &amp; Save
        </button>
      </div>
    );
  }

  return (
    <div className="tempus-card">
      <div className="timer-card-head">
        <Timer size={16} strokeWidth={1.8} className="timer-card-head-icon" />
        <span className="timer-card-head-label">Start Timer</span>
      </div>
      <div className="timer-fields">
        {projects.length === 0 ? (
          <span className="timer-no-projects">No projects available</span>
        ) : (
          <select
            className="timer-select"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            disabled={busy}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="text"
          className="timer-input"
          placeholder="What are you working on? (optional)"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleStart();
          }}
        />
        <button
          type="button"
          className="timer-btn-start"
          disabled={!pick || localBusy || busy}
          onClick={handleStart}
        >
          <Play size={15} strokeWidth={2} />
          Start Timer
        </button>
      </div>
    </div>
  );
}

function StatPair({ summary }: { summary: TempusSummary | null }) {
  const totalMs = summary?.total_ms ?? 0;
  const count = summary?.count ?? 0;

  return (
    <div className="tempus-stats">
      <div className="tempus-stat today">
        <div className="tempus-stat-top">
          <span className="tempus-stat-eyebrow">Today</span>
          <span className="tempus-stat-icon">
            <Clock size={14} strokeWidth={1.8} />
          </span>
        </div>
        <div className="tempus-stat-value">{formatDurationCompact(totalMs)}</div>
      </div>
      <div className="tempus-stat entries">
        <div className="tempus-stat-top">
          <span className="tempus-stat-eyebrow">Entries</span>
          <span className="tempus-stat-icon">
            <Hash size={14} strokeWidth={1.8} />
          </span>
        </div>
        <div className="tempus-stat-value">{count}</div>
      </div>
    </div>
  );
}

function RecentEntries({ entries }: { entries: TempusEntry[] }) {
  return (
    <div className="tempus-card">
      <div className="entries-card-head">
        <h2 className="entries-card-title">Recent Entries</h2>
        {entries.length > 0 && (
          <span className="entries-card-count">{entries.length} shown</span>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="tempus-empty">
          <span className="tempus-empty-orb">
            <Clock size={20} strokeWidth={1.5} />
          </span>
          <span className="tempus-empty-text">No entries yet</span>
        </div>
      ) : (
        <ul className="entries-list">
          {entries.map((entry) => {
            const color = projectColor(entry.project);
            return (
              <li key={entry.id} className="entry-row">
                <span className="entry-dot" style={{ background: color }} />
                <div className="entry-body">
                  <div className="entry-project">
                    {entry.project?.name ?? "—"}
                  </div>
                  {entry.description && (
                    <div className="entry-desc">{entry.description}</div>
                  )}
                  <div className="entry-meta">
                    {formatTimeOfDay(entry.start_time)}
                    {entry.end_time ? ` – ${formatTimeOfDay(entry.end_time)}` : ""}
                  </div>
                </div>
                <span className="entry-duration" style={{ color }}>
                  {formatDurationCompact(entry.duration_ms ?? 0)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function TempusTab() {
  const [timer, setTimer] = useState<TempusTimer>({ active: false });
  const [projects, setProjects] = useState<TempusProjectStat[]>([]);
  const [todaySummary, setTodaySummary] = useState<TempusSummary | null>(null);
  const [recentEntries, setRecentEntries] = useState<TempusEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = useMemo(() => localTz(), []);

  const refresh = useCallback(async () => {
    try {
      const [t, p, td, ent] = await Promise.all([
        tempusApi.getTimer(),
        tempusApi.getProjects(),
        tempusApi.getSummary("today", tz),
        tempusApi.listEntries({ limit: 5 }),
      ]);
      setTimer(t);
      setProjects(p);
      setTodaySummary(td);
      setRecentEntries(ent);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Tempus data");
    }
  }, [tz]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleStart = useCallback(
    async (projectId: string, description: string) => {
      setBusy(true);
      try {
        await tempusApi.start(projectId, description || undefined);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to start timer");
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await tempusApi.stop();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop timer");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="tempus-page">
      <div className="tempus-col">
        <header className="tempus-header">
          <h1 className="tempus-title gradient">Tempus</h1>
          <p className="tempus-date">{todayLabel()}</p>
        </header>

        {error && <div className="tempus-error">{error}</div>}

        <TimerCard
          timer={timer}
          projects={projects}
          busy={busy}
          onStart={handleStart}
          onStop={handleStop}
        />

        <StatPair summary={todaySummary} />

        <RecentEntries entries={recentEntries} />

        <Link href="/tempus/routines" className="tempus-action">
          <CalendarClock size={16} strokeWidth={1.8} className="tempus-action-icon" />
          <span className="tempus-action-label">Routines — recurring AI tasks</span>
          <ChevronRight size={15} strokeWidth={1.8} className="tempus-action-chevron" />
        </Link>

        <Link href="/kiosk/tempus" className="tempus-action">
          <ExternalLink size={16} strokeWidth={1.8} className="tempus-action-icon" />
          <span className="tempus-action-label">Open full Tempus</span>
          <ChevronRight size={15} strokeWidth={1.8} className="tempus-action-chevron" />
        </Link>
      </div>
    </div>
  );
}
