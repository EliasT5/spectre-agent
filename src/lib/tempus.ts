/**
 * Tempus module — client types, formatters, and a typed API client.
 *
 * Tempus is a first-party "native" module: a real shell route (/tempus) that
 * talks to the existing core API (/api/tempus/*) through the shell proxy. The
 * types + formatters are ported verbatim from the monolith so behaviour matches.
 */

export type TempusProject = {
  id: string;
  name: string;
  color: string | null;
  icon?: string | null;
};

export type TempusProjectStat = TempusProject & {
  description?: string | null;
  is_archived?: boolean;
  total_ms: number;
  entry_count: number;
};

export type TempusTimer =
  | { active: false }
  | {
      active: true;
      project_id: string;
      start_time: string;
      paused_ms: number;
      description: string | null;
      project: TempusProject;
    };

export type TempusSummary = {
  total_ms: number;
  count: number;
  by_project: Array<{
    project_id: string;
    project_name: string;
    color: string | null;
    total_ms: number;
  }>;
};

export type TempusEntry = {
  id: string;
  project_id: string | null;
  description: string | null;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  source?: string | null;
  project: TempusProject | null;
};

export function formatTimeOfDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDayLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

const FALLBACK_COLOR = "#6366f1";

export function projectColor(p: { color?: string | null } | null | undefined): string {
  return p?.color ?? FALLBACK_COLOR;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Elapsed ms of a running timer right now (start + paused offset). */
export function elapsedMs(timer: Extract<TempusTimer, { active: true }>, now = Date.now()): number {
  return Math.max(0, now - Date.parse(timer.start_time) - (timer.paused_ms ?? 0));
}

export function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ── API client (via the shell proxy → core /api/tempus/*) ────────────────────
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const tempusApi = {
  getTimer: () => fetch("/api/tempus/timer").then((r) => unwrap<TempusTimer>(r)),
  start: (projectId: string, description?: string) =>
    fetch("/api/tempus/timer/start", jsonInit({ projectId, description })).then((r) => unwrap(r)),
  stop: () => fetch("/api/tempus/timer/stop", { method: "POST" }).then((r) => unwrap(r)),
  getProjects: () =>
    fetch("/api/tempus/projects")
      .then((r) => unwrap<{ items: TempusProjectStat[] }>(r))
      .then((d) => d.items),
  createProject: (name: string, color?: string) =>
    fetch("/api/tempus/projects", jsonInit({ name, color })).then((r) => unwrap<TempusProject>(r)),
  getSummary: (period: "today" | "week" | "month", tz: string) =>
    fetch(`/api/tempus/time-entries/summary?period=${period}&tz=${encodeURIComponent(tz)}`).then(
      (r) => unwrap<TempusSummary>(r),
    ),
  listEntries: (opts?: { projectId?: string; q?: string; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.projectId) p.set("projectId", opts.projectId);
    if (opts?.q) p.set("q", opts.q);
    p.set("limit", String(opts?.limit ?? 50));
    return fetch(`/api/tempus/time-entries?${p.toString()}`)
      .then((r) => unwrap<{ items: TempusEntry[] }>(r))
      .then((d) => d.items);
  },
  addManualEntry: (e: {
    project_id: string;
    start_time: string;
    end_time: string;
    description?: string;
  }) => fetch("/api/tempus/time-entries", jsonInit({ ...e, source: "manual" })).then((r) => unwrap(r)),
  updateEntry: (id: string, patch: { description?: string }) =>
    fetch(`/api/tempus/time-entries/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => unwrap(r)),
  deleteEntry: (id: string) =>
    fetch(`/api/tempus/time-entries/${id}`, { method: "DELETE" }).then((r) => unwrap(r)),
};
