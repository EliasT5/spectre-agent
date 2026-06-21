"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Panel, Chip } from "@/components/ui";
import { CalendarClock, Play, Trash2, MessageSquare, Bell, Cpu, Lock } from "lucide-react";
import { ErrorNote } from "./controls";
import { ScheduleChat } from "./ScheduleChat";
import { opsApi, relativeWhen, type ScheduledJob } from "@/lib/spectre-ops";

// Internal core jobs (self-improvement, nightly maintenance, autonomy) are NOT
// user routines — they live in Activity as background processes, not here.
const SYSTEM_TARGETS = new Set(["skillopt", "dream", "proactive"]);

export function SchedulesPanel() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setJobs(await opsApi.listSchedules());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const userJobs = jobs.filter((j) => !SYSTEM_TARGETS.has(j.target_type));
  const coreJobs = jobs.filter((j) => SYSTEM_TARGETS.has(j.target_type));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <ErrorNote error={err} />

      {/* Describe → Spectre creates it */}
      <Panel icon={<CalendarClock strokeWidth={1.6} />} label="NEW" title="Tell Spectre what to schedule" hud>
        <ScheduleChat onChange={refresh} />
      </Panel>

      {/* Manage — user routines only (system jobs live in Activity) */}
      <Panel icon={<CalendarClock strokeWidth={1.6} />} label={`${userJobs.length}`} title="Your schedules">
        {userJobs.length === 0 ? (
          <span className="muted">No schedules yet — describe one above.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {userJobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                busy={busy}
                onToggle={(en) => act(() => opsApi.updateSchedule(j.id, { enabled: en }))}
                onRun={() => act(() => opsApi.runNow(j.id))}
                onDelete={() => act(() => opsApi.deleteSchedule(j.id))}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* Core processes — Spectre-managed: visible + enable + run-now, but NOT deletable */}
      {coreJobs.length > 0 && (
        <Panel icon={<Cpu strokeWidth={1.6} />} label="CORE" title="Spectre's own processes" aside={<Chip>managed</Chip>}>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12, lineHeight: 1.5 }}>
            Self-improvement, memory upkeep and autonomy. You can enable or run these, but they&apos;re part of the core — not deletable.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {coreJobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                busy={busy}
                core
                onToggle={(en) => act(() => opsApi.updateSchedule(j.id, { enabled: en }))}
                onRun={() => act(() => opsApi.runNow(j.id))}
              />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function describe(j: ScheduledJob): string {
  if (j.schedule_type === "daily") return `daily · ${j.time_of_day ?? "?"}`;
  if (j.schedule_type === "interval") return `every ${Math.round((j.interval_seconds ?? 0) / 60)}m`;
  return "once";
}

function JobRow({
  job,
  busy,
  onToggle,
  onRun,
  onDelete,
  core,
}: {
  job: ScheduledJob;
  busy: boolean;
  onToggle: (en: boolean) => void;
  onRun: () => void;
  onDelete?: () => void;
  core?: boolean;
}) {
  const last = job.scheduled_job_runs?.[0];
  const isChat = job.target_type === "chat";
  const Icon = core ? Cpu : isChat ? MessageSquare : Bell;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--color-border)", opacity: job.enabled ? 1 : 0.55 }}>
      <span title={core ? job.target_type : isChat ? "chat" : "notify"} style={{ color: "var(--color-text-muted)", display: "inline-flex" }}>
        <Icon size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {job.name}
          {!core && job.notify_on_done ? " + notify" : ""}
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          {core ? `${job.target_type} · ` : ""}
          {describe(job)} · next {relativeWhen(job.next_run_at)}
          {last ? ` · last ${last.status}` : ""}
          {job.list_kind ? ` · list:${job.list_kind}` : ""}
        </div>
      </div>
      <Chip on={job.enabled}>{job.enabled ? "on" : "off"}</Chip>
      <button type="button" title="Run now" onClick={onRun} disabled={busy} style={iconBtn}><Play size={14} /></button>
      <button type="button" title={job.enabled ? "Pause" : "Enable"} onClick={() => onToggle(!job.enabled)} disabled={busy} style={iconBtn}>
        {job.enabled ? "⏸" : "▶"}
      </button>
      {onDelete ? (
        <button type="button" title="Delete" onClick={onDelete} disabled={busy} style={iconBtn}><Trash2 size={14} /></button>
      ) : (
        <span title="Core process — managed by Spectre, can't be deleted" style={{ ...iconBtn, cursor: "default" }}><Lock size={13} /></span>
      )}
    </div>
  );
}

const iconBtn: CSSProperties = { background: "none", border: "none", color: "var(--color-text-muted)", cursor: "pointer", padding: 5, display: "inline-flex", fontSize: 13 };
