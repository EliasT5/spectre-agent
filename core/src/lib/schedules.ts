export type ScheduleType = "once" | "interval" | "daily";

export interface ScheduleInput {
  schedule_type: ScheduleType;
  interval_seconds?: number | null;
  run_at?: string | null;
  time_of_day?: string | null;
  timezone?: string | null;
}

export function computeNextRun(input: ScheduleInput, from = new Date()): string | null {
  if (input.schedule_type === "once") {
    return input.run_at ?? null;
  }

  if (input.schedule_type === "interval") {
    const seconds = Number(input.interval_seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds < 60) {
      throw new Error("interval_seconds must be at least 60");
    }
    return new Date(from.getTime() + seconds * 1000).toISOString();
  }

  if (input.schedule_type === "daily") {
    const time = input.time_of_day;
    if (!time || !/^\d{2}:\d{2}$/.test(time)) {
      throw new Error("time_of_day must be HH:MM for daily schedules");
    }
    const [hours, minutes] = time.split(":").map(Number);
    if (hours > 23 || minutes > 59) throw new Error("Invalid time_of_day");

    // V1 uses the server's local timezone. The stored timezone remains on
    // the row so we can upgrade to exact per-zone calculation later.
    const next = new Date(from);
    next.setHours(hours, minutes, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  return null;
}
