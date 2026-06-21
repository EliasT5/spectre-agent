"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Panel, Chip } from "@/components/ui";
import { Activity, CalendarClock, Hammer, Dot } from "lucide-react";
import { ErrorNote } from "./controls";
import { opsApi, relativeWhen, type ScheduledJob, type WorkshopTask } from "@/lib/spectre-ops";

const TERMINAL = new Set(["done", "completed", "error", "failed", "cancelled", "discarded", "aborted"]);

function statusColor(s: string): string {
  const t = s.toLowerCase();
  if (t.includes("run")) return "#22d3ee";
  if (TERMINAL.has(t) && (t.includes("err") || t.includes("fail"))) return "#f87171";
  if (TERMINAL.has(t)) return "#4ade80";
  return "#a78bfa";
}

export function ActivityPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [tasks, setTasks] = useState<WorkshopTask[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [j, w] = await Promise.all([
        opsApi.listSchedules(),
        opsApi.listWorkshop().catch(() => [] as WorkshopTask[]),
      ]);
      setJobs(j);
      setTasks(w);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000); // background view stays live
    return () => clearInterval(t);
  }, [refresh]);

  const enabled = jobs.filter((j) => j.enabled);
  const runningTasks = tasks.filter((t) => !TERMINAL.has(t.status.toLowerCase()));
  const recentRuns = jobs
    .flatMap((j) => (j.scheduled_job_runs ?? []).map((r) => ({ ...r, job: j.name })))
    .filter((r) => r.started_at)
    .sort((a, b) => Date.parse(b.started_at!) - Date.parse(a.started_at!))
    .slice(0, 12);

  const liveCount = enabled.length + runningTasks.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ErrorNote error={err} />

      <Panel icon={<Activity strokeWidth={1.6} />} label={`${liveCount} ACTIVE`} title="Background processes" hud>
        <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>Everything Spectre is running on its own. Refreshes every 10s.</p>
      </Panel>

      {/* Scheduled (recurring) */}
      <Panel icon={<CalendarClock strokeWidth={1.6} />} label={`${enabled.length}`} title="Scheduled">
        {enabled.length === 0 ? (
          <span className="muted">Nothing scheduled.</span>
        ) : (
          enabled.map((j) => {
            const last = j.scheduled_job_runs?.[0];
            return (
              <div key={j.id} style={rowStyle}>
                <Dot size={18} style={{ color: statusColor(j.status), flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.name}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>next {relativeWhen(j.next_run_at)}{last ? ` · last ${last.status}` : ""}</div>
                </div>
                <Chip>{j.target_type}</Chip>
              </div>
            );
          })
        )}
      </Panel>

      {/* Workshop tasks */}
      <Panel icon={<Hammer strokeWidth={1.6} />} label={`${runningTasks.length}`} title="Workshop (self-edit)">
        {runningTasks.length === 0 ? (
          <span className="muted">No workshop tasks in progress.</span>
        ) : (
          runningTasks.map((t) => (
            <div key={t.id} style={rowStyle}>
              <Dot size={18} style={{ color: statusColor(t.status), flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>{t.status}</div>
              </div>
            </div>
          ))
        )}
      </Panel>

      {/* Recent runs */}
      <Panel icon={<Activity strokeWidth={1.6} />} label={`${recentRuns.length}`} title="Recent runs">
        {recentRuns.length === 0 ? (
          <span className="muted">No runs yet.</span>
        ) : (
          recentRuns.map((r) => (
            <div key={r.id} style={rowStyle}>
              <Dot size={18} style={{ color: statusColor(r.status), flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.job}</div>
                <div className="mono muted" style={{ fontSize: 11 }}>{r.status} · {relativeWhen(r.started_at)}{r.error ? ` · ${r.error.slice(0, 40)}` : ""}</div>
              </div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderBottom: "1px solid var(--color-border)" };
