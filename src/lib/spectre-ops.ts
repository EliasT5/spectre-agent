
export type ScheduleType = "once" | "interval" | "daily";
export type TargetType = "chat" | "notify" | "workshop";

export interface JobRun {
  id: string;
  status: string; // queued | running | done | error
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  thread_id: string | null;
}

export interface ScheduledJob {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  schedule_type: ScheduleType;
  interval_seconds: number | null;
  run_at: string | null;
  time_of_day: string | null;
  timezone: string | null;
  target_type: string;
  prompt: string;
  notify_on_done?: boolean;
  list_kind?: string | null;
  list_items?: string[] | null;
  next_run_at: string | null;
  status: string; // idle | paused | running | error
  created_at: string;
  scheduled_job_runs?: JobRun[];
}

export interface WorkshopTask {
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
}

/** What the create-schedule form produces (target "both" = chat + notify_on_done). */
export interface NewSchedule {
  name: string;
  prompt: string;
  schedule_type: ScheduleType;
  target_type: TargetType;
  notify_on_done?: boolean;
  interval_seconds?: number | null;
  run_at?: string | null;
  time_of_day?: string | null;
  timezone?: string;
  list_kind?: string | null;
  list_items?: string[];
  report?: boolean;
}

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const opsApi = {
  listSchedules: () => fetch("/api/schedules").then((r) => unwrap<ScheduledJob[]>(r)),
  createSchedule: (s: NewSchedule) =>
    fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    }).then((r) => unwrap<ScheduledJob>(r)),
  updateSchedule: (id: string, patch: Partial<ScheduledJob>) =>
    fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => unwrap<ScheduledJob>(r)),
  deleteSchedule: (id: string) =>
    fetch(`/api/schedules/${id}`, { method: "DELETE" }).then((r) => unwrap(r)),
  runNow: (id: string) =>
    fetch(`/api/schedules/${id}/run-now`, { method: "POST" }).then((r) => unwrap(r)),
  listWorkshop: () => fetch("/api/workshop").then((r) => unwrap<WorkshopTask[]>(r)),
};

/** Map the friendly "both" choice onto the core's target + notify_on_done. */
export function resolveTarget(choice: "chat" | "notify" | "both"): {
  target_type: TargetType;
  notify_on_done: boolean;
} {
  if (choice === "notify") return { target_type: "notify", notify_on_done: false };
  if (choice === "both") return { target_type: "chat", notify_on_done: true };
  return { target_type: "chat", notify_on_done: false };
}

export function relativeWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const fmt =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${fmt}` : `${fmt} ago`;
}
