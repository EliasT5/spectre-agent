import { randomBytes } from "crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createServiceSupabase } from "@/lib/supabase/server";

export const tempus = new Hono();

const VALID_SOURCES = new Set(["manual", "timer", "ai"]);
const VALID_PERIODS = new Set(["today", "week", "month"]);

type JsonRecord = Record<string, unknown>;

function errorJson(c: Context, error: string, status = 400) {
  return c.json({ error }, status as ContentfulStatusCode);
}

function generateTempusId() {
  return randomBytes(8).toString("hex");
}

function stringField(body: JsonRecord, key: string, required = false) {
  const value = body[key];
  if (typeof value !== "string") {
    return required ? null : undefined;
  }
  const trimmed = value.trim();
  if (required && !trimmed) return null;
  return trimmed;
}

function optionalBoolean(body: JsonRecord, key: string) {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function parsePositiveLimit(value: string | undefined, fallback: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}

function parseIsoDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function normalizeSource(value: unknown) {
  if (value === undefined) return "manual";
  return typeof value === "string" && VALID_SOURCES.has(value) ? value : null;
}

function normalizeTags(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function millisBetween(start: Date, end: Date) {
  return end.getTime() - start.getTime();
}

function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
    second: Number(byType.get("second")),
  };
}

function addDaysUtc(parts: { year: number; month: number; day: number }, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function zonedLocalMidnightToUtc(parts: { year: number; month: number; day: number }, timeZone: string) {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day);
  const offsetAt = (date: Date) => {
    const zoned = getZonedParts(date, timeZone);
    const asUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    );
    return asUtc - date.getTime();
  };

  const first = new Date(utcGuess - offsetAt(new Date(utcGuess)));
  return new Date(utcGuess - offsetAt(first));
}

function getSummaryRange(period: string, timeZone: string) {
  if (!VALID_PERIODS.has(period)) return null;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    return null;
  }

  const today = getZonedParts(new Date(), timeZone);
  let startParts = { year: today.year, month: today.month, day: today.day };
  let endParts: { year: number; month: number; day: number };

  if (period === "week") {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).format(new Date());
    const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    const daysSinceMonday = (dayIndex + 6) % 7;
    startParts = addDaysUtc(startParts, -daysSinceMonday);
    endParts = addDaysUtc(startParts, 7);
  } else if (period === "month") {
    startParts = { year: today.year, month: today.month, day: 1 };
    endParts =
      today.month === 12
        ? { year: today.year + 1, month: 1, day: 1 }
        : { year: today.year, month: today.month + 1, day: 1 };
  } else {
    endParts = addDaysUtc(startParts, 1);
  }

  return {
    start: zonedLocalMidnightToUtc(startParts, timeZone).toISOString(),
    end: zonedLocalMidnightToUtc(endParts, timeZone).toISOString(),
  };
}

type SupabaseLike = ReturnType<typeof createServiceSupabase>;

type ActiveTimerRow = {
  id: number;
  project_id: string;
  start_time: string;
  pause_start: string | null;
  paused_ms: number | null;
  description: string | null;
};

async function stopExistingTimer(supabase: SupabaseLike, timer: ActiveTimerRow, now = new Date()) {
  const start = new Date(timer.start_time);
  const pausedMs =
    Number(timer.paused_ms ?? 0) +
    (timer.pause_start ? Math.max(0, now.getTime() - new Date(timer.pause_start).getTime()) : 0);
  const durationMs = Math.max(0, now.getTime() - start.getTime() - pausedMs);

  const { data: entry, error: insertError } = await supabase
    .from("tempus_time_entries")
    .insert({
      id: generateTempusId(),
      project_id: timer.project_id,
      description: timer.description ?? "",
      start_time: timer.start_time,
      end_time: now.toISOString(),
      duration_ms: durationMs,
      source: "timer",
    })
    .select("*, project:tempus_projects(id, name, color, icon)")
    .single();

  if (insertError) return { entry: null, error: insertError.message };

  const { error: deleteError } = await supabase
    .from("tempus_active_timer")
    .delete()
    .eq("id", timer.id);

  if (deleteError) return { entry: null, error: deleteError.message };
  return { entry, error: null };
}

tempus.get("/projects", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  const supabase = createServiceSupabase();
  let query = supabase
    .from("tempus_projects")
    .select("*")
    .order("created_at", { ascending: false });

  if (!includeArchived) query = query.eq("is_archived", false);

  const { data, error } = await query;
  if (error) return errorJson(c, error.message, 500);

  const projects = data ?? [];
  const projectIds = projects.map((project: { id: string }) => project.id);
  if (projectIds.length === 0) return c.json({ items: [] });

  const { data: entries, error: entriesError } = await supabase
    .from("tempus_time_entries")
    .select("project_id, duration_ms")
    .in("project_id", projectIds);

  if (entriesError) return errorJson(c, entriesError.message, 500);

  const stats = new Map<string, { total_ms: number; entry_count: number }>();
  for (const entry of (entries ?? []) as Array<{ project_id: string; duration_ms: number | string | null }>) {
    const current = stats.get(entry.project_id) ?? { total_ms: 0, entry_count: 0 };
    current.total_ms += Number(entry.duration_ms ?? 0);
    current.entry_count += 1;
    stats.set(entry.project_id, current);
  }

  const items = projects.map((project: { id: string }) => ({
    ...project,
    total_ms: stats.get(project.id)?.total_ms ?? 0,
    entry_count: stats.get(project.id)?.entry_count ?? 0,
  }));

  return c.json({ items });
});

tempus.post("/projects", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const name = stringField(body, "name", true);
  if (name === null) return errorJson(c, "name required");

  const row = {
    id: generateTempusId(),
    name,
    color: stringField(body, "color") ?? "#6366f1",
    icon: stringField(body, "icon") ?? "folder",
    description: stringField(body, "description") ?? "",
  };

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_projects")
    .insert(row)
    .select()
    .single();

  if (error) return errorJson(c, error.message, 500);
  return c.json(data, 201);
});

tempus.get("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();

  const { data: project, error: projectError } = await supabase
    .from("tempus_projects")
    .select("*")
    .eq("id", id)
    .single();

  if (projectError) return errorJson(c, projectError.message, 404);

  const { data: entries, error: entriesError, count } = await supabase
    .from("tempus_time_entries")
    .select("duration_ms", { count: "exact" })
    .eq("project_id", id);

  if (entriesError) return errorJson(c, entriesError.message, 500);

  const total_ms = (entries ?? []).reduce(
    (sum: number, entry: { duration_ms: number | string | null }) =>
      sum + Number(entry.duration_ms ?? 0),
    0,
  );

  return c.json({ ...project, total_ms, entry_count: count ?? 0 });
});

tempus.put("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const update: JsonRecord = { updated_at: new Date().toISOString() };

  const name = stringField(body, "name");
  if (name !== undefined) {
    if (!name) return errorJson(c, "name must not be empty");
    update.name = name;
  }
  for (const key of ["color", "icon", "description"]) {
    const value = stringField(body, key);
    if (value !== undefined) update[key] = value;
  }
  const isArchived = optionalBoolean(body, "is_archived");
  if (isArchived !== undefined) update.is_archived = isArchived;

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_projects")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) return errorJson(c, error.message, 500);
  return c.json(data);
});

tempus.delete("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("tempus_projects").delete().eq("id", id);

  if (error) return errorJson(c, error.message, 500);
  return new Response(null, { status: 204 });
});

tempus.get("/projects/:id/entries", async (c) => {
  const id = c.req.param("id");
  const limit = parsePositiveLimit(c.req.query("limit"), 200, 1000);
  if (limit === null) return errorJson(c, "limit must be a positive integer");

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_time_entries")
    .select("*")
    .eq("project_id", id)
    .order("start_time", { ascending: false })
    .limit(limit);

  if (error) return errorJson(c, error.message, 500);
  return c.json({ items: data ?? [] });
});

tempus.get("/time-entries", async (c) => {
  const limit = parsePositiveLimit(c.req.query("limit"), 100, 1000);
  if (limit === null) return errorJson(c, "limit must be a positive integer");

  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from && !parseIsoDate(from)) return errorJson(c, "from must be a valid date");
  if (to && !parseIsoDate(to)) return errorJson(c, "to must be a valid date");

  const supabase = createServiceSupabase();
  let query = supabase
    .from("tempus_time_entries")
    .select("*, project:tempus_projects(id, name, color, icon)")
    .order("start_time", { ascending: false })
    .limit(limit);

  const projectId = c.req.query("projectId")?.trim();
  const q = c.req.query("q")?.trim();
  if (projectId) query = query.eq("project_id", projectId);
  if (from) query = query.gte("start_time", new Date(from).toISOString());
  if (to) query = query.lte("start_time", new Date(to).toISOString());
  if (q) query = query.ilike("description", `%${q}%`);

  const { data, error } = await query;
  if (error) return errorJson(c, error.message, 500);
  return c.json({ items: data ?? [] });
});

tempus.post("/time-entries", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const project_id = stringField(body, "project_id", true);
  if (project_id === null) return errorJson(c, "project_id required");

  const start = parseIsoDate(body.start_time);
  const end = parseIsoDate(body.end_time);
  if (!start) return errorJson(c, "start_time must be a valid date");
  if (!end) return errorJson(c, "end_time must be a valid date");
  if (start.getTime() > end.getTime()) return errorJson(c, "start_time must be before end_time");

  const source = normalizeSource(body.source);
  if (source === null) return errorJson(c, "source must be manual, timer, or ai");

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_time_entries")
    .insert({
      id: generateTempusId(),
      project_id,
      description: stringField(body, "description") ?? "",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      duration_ms: millisBetween(start, end),
      source,
    })
    .select("*, project:tempus_projects(id, name, color, icon)")
    .single();

  if (error) return errorJson(c, error.message, 500);
  return c.json(data, 201);
});

type SummaryEntry = {
  duration_ms: number | string | null;
  project_id: string;
  project:
    | {
        id: string;
        name: string;
        color: string | null;
      }
    | null;
};

tempus.get("/time-entries/summary", async (c) => {
  const period = c.req.query("period") ?? "today";
  const tz = c.req.query("tz") ?? "UTC";
  const range = getSummaryRange(period, tz);
  if (!range) return errorJson(c, "period or timezone is invalid");

  const supabase = createServiceSupabase();
  const { data, error, count } = await supabase
    .from("tempus_time_entries")
    .select("duration_ms, project_id, project:tempus_projects(id, name, color)", { count: "exact" })
    .gte("start_time", range.start)
    .lt("start_time", range.end);

  if (error) return errorJson(c, error.message, 500);

  const byProject = new Map<
    string,
    { project_id: string; project_name: string; color: string | null; total_ms: number }
  >();
  let total_ms = 0;

  // Supabase types a joined relation as an array; the runtime shape here is a
  // single object, so cast through unknown (the typed client now surfaces this).
  for (const entry of (data ?? []) as unknown as SummaryEntry[]) {
    const duration = Number(entry.duration_ms ?? 0);
    total_ms += duration;
    const current =
      byProject.get(entry.project_id) ??
      {
        project_id: entry.project_id,
        project_name: entry.project?.name ?? "",
        color: entry.project?.color ?? null,
        total_ms: 0,
      };
    current.total_ms += duration;
    byProject.set(entry.project_id, current);
  }

  return c.json({
    total_ms,
    count: count ?? 0,
    by_project: Array.from(byProject.values()).sort((a, b) => b.total_ms - a.total_ms),
  });
});

tempus.get("/time-entries/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_time_entries")
    .select("*, project:tempus_projects(id, name, color, icon)")
    .eq("id", id)
    .single();

  if (error) return errorJson(c, error.message, 404);
  return c.json(data);
});

tempus.put("/time-entries/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const supabase = createServiceSupabase();

  const { data: existing, error: existingError } = await supabase
    .from("tempus_time_entries")
    .select("*")
    .eq("id", id)
    .single();

  if (existingError) return errorJson(c, existingError.message, 404);

  const update: JsonRecord = { updated_at: new Date().toISOString() };
  const projectId = stringField(body, "project_id");
  if (projectId !== undefined) {
    if (!projectId) return errorJson(c, "project_id must not be empty");
    update.project_id = projectId;
  }

  const description = stringField(body, "description");
  if (description !== undefined) update.description = description;

  const source = body.source === undefined ? undefined : normalizeSource(body.source);
  if (source === null) return errorJson(c, "source must be manual, timer, or ai");
  if (source !== undefined) update.source = source;

  const tags = normalizeTags(body.tags);
  if (tags === null) return errorJson(c, "tags must be an array of strings");
  if (tags !== undefined) update.tags = tags;

  const start =
    body.start_time === undefined ? new Date(existing.start_time as string) : parseIsoDate(body.start_time);
  const end =
    body.end_time === undefined ? new Date(existing.end_time as string) : parseIsoDate(body.end_time);

  if (body.start_time !== undefined && !start) return errorJson(c, "start_time must be a valid date");
  if (body.end_time !== undefined && !end) return errorJson(c, "end_time must be a valid date");
  if (!start || !end) return errorJson(c, "start_time and end_time are required for duration");
  if (start.getTime() > end.getTime()) return errorJson(c, "start_time must be before end_time");

  if (body.start_time !== undefined) update.start_time = start.toISOString();
  if (body.end_time !== undefined) update.end_time = end.toISOString();
  if (body.start_time !== undefined || body.end_time !== undefined) {
    update.duration_ms = millisBetween(start, end);
  }

  const { data, error } = await supabase
    .from("tempus_time_entries")
    .update(update)
    .eq("id", id)
    .select("*, project:tempus_projects(id, name, color, icon)")
    .single();

  if (error) return errorJson(c, error.message, 500);
  return c.json(data);
});

tempus.delete("/time-entries/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("tempus_time_entries").delete().eq("id", id);

  if (error) return errorJson(c, error.message, 500);
  return new Response(null, { status: 204 });
});

tempus.get("/timer", async (c) => {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("tempus_active_timer")
    .select("project_id, start_time, paused_ms, description, project:tempus_projects(id, name, color, icon)")
    .eq("id", 1)
    .maybeSingle();

  if (error) return errorJson(c, error.message, 500);
  if (!data) return c.json({ active: false });

  return c.json({ active: true, ...data });
});

tempus.post("/timer/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as JsonRecord;
  const projectId = stringField(body, "projectId", true);
  if (projectId === null) return errorJson(c, "projectId required");

  const supabase = createServiceSupabase();
  const { data: existing, error: existingError } = await supabase
    .from("tempus_active_timer")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (existingError) return errorJson(c, existingError.message, 500);
  if (existing) {
    const stopped = await stopExistingTimer(supabase, existing);
    if (stopped.error) return errorJson(c, stopped.error, 500);
  }

  const { data, error } = await supabase
    .from("tempus_active_timer")
    .insert({
      id: 1,
      project_id: projectId,
      start_time: new Date().toISOString(),
      paused_ms: 0,
      description: stringField(body, "description") ?? "",
    })
    .select("*, project:tempus_projects(id, name, color, icon)")
    .single();

  if (error) return errorJson(c, error.message, 500);
  return c.json(data, 201);
});

tempus.post("/timer/stop", async (c) => {
  const supabase = createServiceSupabase();
  const { data: timer, error } = await supabase
    .from("tempus_active_timer")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) return errorJson(c, error.message, 500);
  if (!timer) return errorJson(c, "No active timer.", 400);

  const stopped = await stopExistingTimer(supabase, timer);
  if (stopped.error) return errorJson(c, stopped.error, 500);

  return c.json({ entry: stopped.entry });
});
