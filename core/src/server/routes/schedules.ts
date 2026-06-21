import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { computeNextRun } from "@/lib/schedules";
import { REPORT_INSTRUCTIONS } from "@/lib/schedules-report";
import { verifyBrokerToken } from "@/lib/permission/broker";

// Matches the scheduler worker's per-job timeout; a lock older than 2× this is
// presumed crashed (see /claim stale-lock reclaim).
const JOB_TIMEOUT_MS = Number(process.env.SPECTRE_JOB_TIMEOUT_MS || 30 * 60 * 1000);

export const schedules = new Hono();

schedules.get("/", async (c) => {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("scheduled_jobs")
    .select("*, scheduled_job_runs(id,status,started_at,completed_at,error,thread_id)")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data ?? []);
});

schedules.post("/", async (c) => {
  const supabase = createServiceSupabase();
  const body = await c.req.json().catch(() => ({}));

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const scheduleType = body.schedule_type;
  const targetType = body.target_type ?? "chat";
  const report = body.report === true && targetType === "chat";
  const prompt = report ? `${rawPrompt}\n${REPORT_INSTRUCTIONS}` : rawPrompt;
  const notifyOnDone = body.notify_on_done === true;
  const listKind =
    typeof body.list_kind === "string" && body.list_kind.trim()
      ? body.list_kind.trim()
      : null;
  const listItems = Array.isArray(body.list_items)
    ? body.list_items.filter((x: unknown): x is string => typeof x === "string")
    : [];

  if (!name || !rawPrompt) {
    return c.json({ error: "name and prompt required" }, 400);
  }
  if (!["once", "interval", "daily"].includes(scheduleType)) {
    return c.json({ error: "schedule_type must be once|interval|daily" }, 400);
  }
  if (!["chat", "workshop", "notify"].includes(targetType)) {
    return c.json({ error: "target_type must be chat|workshop|notify" }, 400);
  }

  let nextRunAt: string | null;
  try {
    nextRunAt = computeNextRun({
      schedule_type: scheduleType,
      interval_seconds: body.interval_seconds ?? null,
      run_at: body.run_at ?? null,
      time_of_day: body.time_of_day ?? null,
      timezone: body.timezone ?? "UTC",
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const payload = {
    name,
    description: typeof body.description === "string" ? body.description : null,
    enabled: body.enabled !== false,
    schedule_type: scheduleType,
    interval_seconds: body.interval_seconds ?? null,
    run_at: body.run_at ?? null,
    time_of_day: body.time_of_day ?? null,
    timezone: body.timezone ?? "UTC",
    target_type: targetType,
    prompt,
    notify_on_done: notifyOnDone,
    list_kind: listKind,
    list_items: listItems,
    model_hint: typeof body.model_hint === "string" && body.model_hint ? body.model_hint : null,
    thread_id: typeof body.thread_id === "string" && body.thread_id ? body.thread_id : null,
    next_run_at: nextRunAt,
    status: body.enabled === false ? "paused" : "idle",
  };

  let { data, error } = await supabase
    .from("scheduled_jobs")
    .insert(payload)
    .select()
    .single();

  if (error && /notify_on_done|list_kind|list_items/i.test(error.message)) {
    const { notify_on_done: _a, list_kind: _b, list_items: _c, ...rest } = payload;
    void _a; void _b; void _c;
    ({ data, error } = await supabase
      .from("scheduled_jobs")
      .insert(rest)
      .select()
      .single());
  }

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

schedules.post("/claim", async (c) => {
  if (!verifyBrokerToken(c.req.header("x-spectre-service-token") ?? null)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = createServiceSupabase();
  const body = await c.req.json().catch(() => ({}));
  const workerId = typeof body.worker_id === "string" ? body.worker_id : "scheduler";

  const now = new Date().toISOString();

  // 1) Normal due jobs.
  let { data: due, error: dueError } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("enabled", true)
    .lte("next_run_at", now)
    .in("status", ["idle", "failed"])
    .order("next_run_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (dueError) return c.json({ error: dueError.message }, 500);

  // 2) Else reclaim a CRASHED job: locked_at is written on claim but nothing read
  //    it, so a job that died mid-run (e.g. the WSL-shutdown failure mode) was
  //    stuck 'running' forever. A lock older than 2× the job timeout is presumed
  //    dead and reclaimable.
  if (!due) {
    const staleLock = new Date(Date.now() - 2 * JOB_TIMEOUT_MS).toISOString();
    const { data: stale } = await supabase
      .from("scheduled_jobs")
      .select("*")
      .eq("enabled", true)
      .eq("status", "running")
      .lt("locked_at", staleLock)
      .order("next_run_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    due = stale ?? null;
    if (due) console.warn(`[schedules] reclaiming stale job ${due.id} (locked_at ${due.locked_at})`);
  }

  if (!due) return c.json({ job: null });

  // Atomic claim (CAS): only if the row still matches what we read. For a
  // reclaimed stale job also match locked_at so we never steal a job another
  // worker (re)locked between our select and this update.
  let claim = supabase
    .from("scheduled_jobs")
    .update({ status: "running", locked_at: now, locked_by: workerId, last_error: null })
    .eq("id", due.id)
    .eq("status", due.status);
  if (due.status === "running") claim = claim.eq("locked_at", due.locked_at);
  const { data: claimed, error: claimError } = await claim.select().maybeSingle();

  if (claimError) return c.json({ error: claimError.message }, 409);
  if (!claimed) return c.json({ job: null }); // lost the race — another worker won
  return c.json({ job: claimed });
});

schedules.get("/:scheduleId", async (c) => {
  const scheduleId = c.req.param("scheduleId");
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("scheduled_jobs")
    .select("*, scheduled_job_runs(*)")
    .eq("id", scheduleId)
    .order("started_at", { referencedTable: "scheduled_job_runs", ascending: false })
    .single();

  if (error) return c.json({ error: error.message }, 404);
  return c.json(data);
});

schedules.patch("/:scheduleId", async (c) => {
  const scheduleId = c.req.param("scheduleId");
  const supabase = createServiceSupabase();
  const body = await c.req.json().catch(() => ({}));

  const { data: current, error: lookupError } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .eq("id", scheduleId)
    .single();
  if (lookupError || !current) {
    return c.json({ error: "Schedule not found" }, 404);
  }

  const nextInput = {
    schedule_type: body.schedule_type ?? current.schedule_type,
    interval_seconds: body.interval_seconds ?? current.interval_seconds,
    run_at: body.run_at ?? current.run_at,
    time_of_day: body.time_of_day ?? current.time_of_day,
    timezone: body.timezone ?? current.timezone,
  };

  const patch: Record<string, unknown> = { ...body };
  if (
    "schedule_type" in body ||
    "interval_seconds" in body ||
    "run_at" in body ||
    "time_of_day" in body ||
    "enabled" in body
  ) {
    try {
      patch.next_run_at = body.enabled === false ? current.next_run_at : computeNextRun(nextInput);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }
  if ("enabled" in body) patch.status = body.enabled === false ? "paused" : "idle";

  const { data, error } = await supabase
    .from("scheduled_jobs")
    .update(patch)
    .eq("id", scheduleId)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

schedules.delete("/:scheduleId", async (c) => {
  const scheduleId = c.req.param("scheduleId");
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("scheduled_jobs").delete().eq("id", scheduleId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

schedules.post("/:scheduleId/run-now", async (c) => {
  const scheduleId = c.req.param("scheduleId");
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("scheduled_jobs")
    .update({
      enabled: true,
      status: "idle",
      next_run_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", scheduleId)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});
