import { createClient } from "@supabase/supabase-js";
import { buildListBlock, parseRoutineOps, applyOps } from "./routine-list.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load ../.env.local for standalone runs (systemd passes env in prod).
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* rely on real env */
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SPECTRE_APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000";
const SPECTRE_SERVICE_TOKEN = process.env.SPECTRE_SERVICE_TOKEN || "";
const CORE_TOKEN = process.env.CORE_TOKEN || ""; // core gates /api/* on this
const WORKER_ID = process.env.SPECTRE_SCHEDULER_ID || `scheduler-${process.pid}`;
const POLL_MS = Number(process.env.SPECTRE_SCHEDULER_POLL_MS || 15_000);
// Scheduled jobs (dream / proactive bounded-run / skillopt) are long agentic
// turns; like the chat runner they must not be cut by bun's ~300s fetch ceiling.
const JOB_TIMEOUT_MS = Number(process.env.SPECTRE_JOB_TIMEOUT_MS || 30 * 60 * 1000);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let busy = false;

console.log(`[scheduler] starting as ${WORKER_ID}, poll=${POLL_MS}ms`);
setInterval(() => void tick(), POLL_MS);
void tick();

async function tick() {
  if (busy) return;
  busy = true;
  try {
    while (true) {
      const job = await claimJob();
      if (!job) break;
      await runJob(job);
    }
  } catch (err) {
    console.error("[scheduler] tick failed", err);
  } finally {
    busy = false;
  }
}

async function claimJob() {
  const data = await appFetch("/api/schedules/claim", {
    method: "POST",
    body: JSON.stringify({ worker_id: WORKER_ID }),
  });
  return data?.job ?? null;
}

async function runJob(job) {
  console.log(`[scheduler] running ${job.id} ${job.name}`);
  const run = await createRun(job);
  let output = "";
  let error = null;
  let threadId = job.thread_id ?? null;

  try {
    if (job.target_type === "chat") {
      const result = await runChatJob(job);
      output = result.output;
      threadId = result.threadId;
      // Fold any routine-ops block into the routine's persistent list.
      await persistListOps(job, output);
    } else if (job.target_type === "workshop") {
      output = await runWorkshopJob(job);
    } else if (job.target_type === "notify") {
      output = await runNotifyJob(job);
    } else if (job.target_type === "dream") {
      output = await runDreamJob(job);
    } else if (job.target_type === "proactive") {
      output = await runProactiveJob(job);
    } else if (job.target_type === "skillopt") {
      output = await runSkillOptJob(job);
    } else if (job.target_type === "skill_curation") {
      output = await runSkillCurationJob();
    } else {
      throw new Error(`Unknown target_type ${job.target_type}`);
    }

    // Push-on-done: a chat job (e.g. a Tempus "Routine" that produced a
    // report) can ping the phone with a deep link to the thread it wrote to.
    if (job.notify_on_done && job.target_type === "chat" && threadId) {
      try {
        await appFetch("/api/push/send", {
          method: "POST",
          body: JSON.stringify({
            title: job.name,
            body: "Your report is ready.",
            url: `/chat/${threadId}`,
          }),
        });
      } catch (pushErr) {
        // Non-fatal — the report still lives in the thread.
        console.error(`[scheduler] push-on-done failed for ${job.id}`, pushErr);
      }
    }

    await finishRun(run.id, { status: "completed", output, threadId });
    await finishJob(job, null, threadId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] job ${job.id} failed`, error);
    await finishRun(run.id, { status: "failed", error, threadId });
    await finishJob(job, error, threadId);
  }
}

async function createRun(job) {
  const { data, error } = await supabase
    .from("scheduled_job_runs")
    .insert({ job_id: job.id, status: "running", thread_id: job.thread_id ?? null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function finishRun(runId, { status, output, error, threadId }) {
  const { error: updateError } = await supabase
    .from("scheduled_job_runs")
    .update({
      status,
      output: output ?? null,
      error: error ?? null,
      thread_id: threadId ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (updateError) console.error("[scheduler] finishRun failed", updateError);
}

async function finishJob(job, error, threadId) {
  const nextRunAt = error || job.schedule_type === "once" ? null : computeNextRun(job);
  const enabled = error ? job.enabled : job.schedule_type === "once" ? false : job.enabled;
  const { error: updateError } = await supabase
    .from("scheduled_jobs")
    .update({
      enabled,
      status: error ? "failed" : enabled ? "idle" : "paused",
      last_run_at: new Date().toISOString(),
      next_run_at: nextRunAt,
      last_error: error,
      thread_id: threadId ?? job.thread_id ?? null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", job.id);
  if (updateError) console.error("[scheduler] finishJob failed", updateError);
}

async function runChatJob(job) {
  // Recurring routines run one-shot: a FRESH thread every run so context
  // never accumulates across days (claude-code --resume would otherwise
  // replay the whole prior session — quadratic cost + context-window wall).
  // Continuity lives in the routine's state list, not the thread. Only a
  // 'once' job may target a pre-pinned thread. finishJob writes the new
  // thread_id back, so the "View report" link always points at the latest run.
  let threadId = job.schedule_type === "once" ? job.thread_id : null;
  if (!threadId) {
    const date = new Date().toISOString().slice(0, 10);
    const thread = await appFetch("/api/threads", {
      method: "POST",
      body: JSON.stringify({ title: `${job.name} — ${date}`, model_hint: job.model_hint ?? null }),
    });
    threadId = thread.id;
  }

  // Inject the routine's persistent state list (blacklist/notes/todos/…) so
  // the model sees prior state and can update it via a routine-ops block.
  const listBlock = buildListBlock(job.list_kind, job.list_items);
  const content = listBlock
    ? `[Scheduled job: ${job.name}]\n\n${job.prompt}\n\n${listBlock}`
    : `[Scheduled job: ${job.name}]\n\n${job.prompt}`;

  // Durable path: enqueue the turn, then wait for the chat-runner to finish it.
  const { assistantMessageId } = await appFetch(`/api/threads/${threadId}/enqueue`, {
    method: "POST",
    body: JSON.stringify({ content, ...(job.model_hint ? { model_hint: job.model_hint } : {}) }),
  });
  const output = await waitForMessage(assistantMessageId);
  return { threadId, output };
}

// Poll the assistant row until the durable run completes; return its text.
// timeoutMs must be >= JOB_TIMEOUT_MS so a long run isn't falsely marked failed.
async function waitForMessage(messageId, timeoutMs = JOB_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("messages")
      .select("content, status")
      .eq("id", messageId)
      .single();
    if (data && (data.status === "done" || data.status === "error" || data.status === "cancelled")) {
      if (data.status === "error") throw new Error("scheduled chat run failed");
      return data.content || "";
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("scheduled chat run timed out");
}

// Fold a finished run's routine-ops block into the routine's stored list.
async function persistListOps(job, output) {
  if (!job.list_kind) return;
  const ops = parseRoutineOps(output);
  if (!ops || (!ops.add.length && !ops.remove.length)) return;
  const next = applyOps(job.list_items, ops);
  const { error } = await supabase
    .from("scheduled_jobs")
    .update({ list_items: next })
    .eq("id", job.id);
  if (error) console.error(`[scheduler] persistListOps failed for ${job.id}`, error);
  else console.log(`[scheduler] ${job.id} list now ${next.length} item(s)`);
}

async function runWorkshopJob(job) {
  const task = await appFetch("/api/workshop", {
    method: "POST",
    body: JSON.stringify({ title: `[scheduled] ${job.name}`, description: job.prompt }),
  });
  await appFetch(`/api/workshop/${task.id}/execute`, { method: "POST" });
  return `Workshop task queued: ${task.id}`;
}

async function runNotifyJob(job) {
  const data = await appFetch("/api/push/send", {
    method: "POST",
    body: JSON.stringify({ title: job.name, body: job.prompt.slice(0, 120), url: "/chat" }),
  });
  return `Notification sent:\n${JSON.stringify(data, null, 2)}`;
}

async function runDreamJob() {
  // Nightly maintenance: memory consolidation + system health sweep.
  const data = await appFetch("/api/dream/nightly", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return `Nightly maintenance:\n${JSON.stringify(data, null, 2)}`;
}

async function runProactiveJob() {
  // P1.1 bounded proactive turn: the brain acts on its own with a safe,
  // read-mostly tool whitelist (memory/notify/schedule-read/calendar/analytics)
  // under a wall-clock + quota budget. The endpoint pre-seeds tool policies,
  // captures the run to monitor_events, and degrades to proposal-only if the
  // policy table isn't applied yet — so this job stays a thin trigger.
  const data = await appFetch("/api/proactive/bounded-run", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return `Proactive run (${data?.mode ?? "?"}${data?.degraded ? ", degraded" : ""}):\n${JSON.stringify(
    data,
    null,
    2,
  )}`;
}

async function runSkillOptJob(job) {
  // Offline SkillOpt round: rollout -> reflect (OPUS) -> val-gate -> test, then
  // ledger to skillopt_runs. DRY-RUN — the endpoint NEVER writes the live
  // skills/<skill>/SKILL.md (the workshop-gated deploy of an accepted candidate
  // is Step 6). The skill to optimize rides in the prompt field (default 'memory').
  const skill = (job.prompt && job.prompt.trim()) || "memory";
  const data = await appFetch("/api/skillopt/run", {
    method: "POST",
    body: JSON.stringify({ skill }),
  });
  return `SkillOpt round (${skill}):\n${JSON.stringify(data, null, 2)}`;
}

async function runSkillCurationJob() {
  // Proposal-only skill-library review: 14-day skill.read counts + redundancy.
  // Never deletes — the human acts on the proposal (the SkillOpt gate philosophy).
  const data = await appFetch("/api/skills/curate", { method: "POST", body: JSON.stringify({}) });
  return `Skill curation proposal (${data?.skills ?? "?"} skills):\n${data?.proposal || JSON.stringify(data, null, 2)}`;
}

async function appFetch(path, opts = {}) {
  const res = await fetch(`${SPECTRE_APP_URL}${path}`, {
    ...opts,
    // timeout:false disables bun's hard ~300s client ceiling (an AbortSignal can't
    // extend it); the signal then gives a sane upper bound for a stuck job.
    timeout: false,
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(SPECTRE_SERVICE_TOKEN ? { "X-Spectre-Service-Token": SPECTRE_SERVICE_TOKEN } : {}),
      ...(CORE_TOKEN ? { "x-spectre-core-token": CORE_TOKEN } : {}),
      ...opts.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${text}`);
  return data;
}

function computeNextRun(job) {
  const now = new Date();
  if (job.schedule_type === "interval") {
    return new Date(now.getTime() + Number(job.interval_seconds) * 1000).toISOString();
  }
  if (job.schedule_type === "daily") {
    const [h, m] = String(job.time_of_day || "09:00").split(":").map(Number);
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  return null;
}
