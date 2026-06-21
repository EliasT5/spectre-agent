// Durable chat runner. Polls Supabase for QUEUED assistant messages, claims
// each atomically, and asks the core to execute it (/run writes the streamed
// output into the row; the UI watches via Realtime). The run is decoupled from
// any UI connection — close the UI and this keeps going. Stop is handled by the
// core /run itself (it polls the row's status for 'cancelled').
//
//   node worker/chat-runner.mjs
//
// Env (auto-loaded from ../.env.local if present): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, CORE_TOKEN, SPECTRE_APP_URL.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Minimal .env.local loader so the runner is self-sufficient as a standalone
// process (Next loads env for the app; this process doesn't get that for free).
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — rely on real env */
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:8787";
const CORE_TOKEN = process.env.CORE_TOKEN || "";
const POLL_MS = Number(process.env.CHAT_RUNNER_POLL_MS || 1000);
// Upper bound for a single durable turn. The core disables its server idle
// timeout (so it never cuts a long silent /run), so this is just a sane
// client-side ceiling so a genuinely stuck turn can't pin the runner forever.
// Generous by default (30 min) because CPU/Ollama tool-turns are slow.
const TURN_TIMEOUT_MS = Number(process.env.SPECTRE_TURN_TIMEOUT_MS || 30 * 60 * 1000);
// A 'running' row whose lease is older than STALE_MS is considered orphaned and
// safe to requeue. Must be safely larger than the longest realistic turn so a
// legitimately slow run (which heartbeats locked_at every 60 s) is never stolen.
const STALE_MS = Number(process.env.CHAT_RUNNER_STALE_MS || 20 * 60 * 1000);
// How often to refresh the lease while a run is in-flight.
const HEARTBEAT_MS = Number(process.env.CHAT_RUNNER_HEARTBEAT_MS || 60 * 1000);

// Stable identity for this process instance — written into locked_by on every
// claim and heartbeat so overlapping runners are distinguishable in the DB.
const RUNNER_ID = randomUUID();

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[chat-runner] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
const inflight = new Set();

// Debugging engine: the runner records its own failures straight to
// monitor_events (it has the service client), so a problem is captured even
// when the core itself is the thing that's down.
async function report(severity, component, description, detail) {
  try {
    await supabase.from("monitor_events").insert({
      severity,
      component,
      description: String(description).slice(0, 1000),
      analysis: { detail: detail ?? null },
    });
  } catch (e) {
    console.error(`[chat-runner] could not record event: ${e.message}`);
  }
}

async function runOne(threadId, messageId) {
  console.log(`[chat-runner] running ${messageId} (thread ${threadId.slice(0, 8)})`);

  // Heartbeat: refresh the lease periodically so a legitimately long run is
  // never seen as stale by the orphan-recovery of a concurrent runner restart.
  const heartbeatTimer = setInterval(async () => {
    try {
      await supabase
        .from("messages")
        .update({ locked_at: new Date().toISOString(), locked_by: RUNNER_ID })
        .eq("id", messageId)
        .eq("status", "running"); // no-op if the row was already cancelled/errored
    } catch (e) {
      console.warn(`[chat-runner] heartbeat failed for ${messageId}: ${e.message}`);
    }
  }, HEARTBEAT_MS);

  try {
    const res = await fetch(`${APP_URL}/api/threads/${threadId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-spectre-core-token": CORE_TOKEN },
      body: JSON.stringify({ messageId }),
      // timeout:false disables bun's hard ~300s client ceiling (which an
      // AbortSignal cannot extend); the signal is then the real upper bound.
      timeout: false,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    const out = await res.json().catch(() => ({}));
    console.log(`[chat-runner] ${messageId} -> HTTP ${res.status} status=${out.status ?? "?"}`);
    if (!res.ok) {
      await supabase.from("messages").update({ status: "error" }).eq("id", messageId);
      await report("warning", "chat-runner", `core /run returned ${res.status}`, out);
    }
  } catch (e) {
    console.error(`[chat-runner] core unreachable for ${messageId}: ${e.message}`);
    await supabase
      .from("messages")
      .update({ status: "error", content: "⚠️ runner could not reach the core" })
      .eq("id", messageId);
    await report("critical", "chat-runner", `core unreachable while running a chat: ${e.message}`, { messageId });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

// Orphan recovery: a 'running' assistant message whose lease is NULL or older
// than STALE_MS belongs to a dead runner and should be requeued. A row with a
// fresh lease is owned by another live runner and must NOT be touched.
//
// PostgREST cannot express "IS NULL OR < cutoff" in one filter, so we fetch all
// 'running' assistant rows and filter in JS — the set is expected to be tiny.
async function recoverOrphans() {
  const cutoff = new Date(Date.now() - STALE_MS);
  const cutoffIso = cutoff.toISOString();

  const { data, error } = await supabase
    .from("messages")
    .select("id, locked_at")
    .eq("role", "assistant")
    .eq("status", "running");
  if (error) {
    console.error(`[chat-runner] orphan recovery fetch failed: ${error.message}`);
    return;
  }

  // Only requeue rows with a null or stale lease.
  const stale = (data ?? []).filter(
    (r) => r.locked_at === null || r.locked_at === undefined || r.locked_at < cutoffIso,
  );
  if (stale.length === 0) return;

  const staleIds = stale.map((r) => r.id);
  const { error: upErr } = await supabase
    .from("messages")
    .update({ status: "queued", locked_at: null, locked_by: null })
    .in("id", staleIds);
  if (upErr) {
    console.error(`[chat-runner] orphan recovery requeue failed: ${upErr.message}`);
    return;
  }
  console.log(`[chat-runner] recovered ${stale.length} stale-leased run(s) -> requeued`);
  await report("warning", "chat-runner", `requeued ${stale.length} orphaned chat run(s) after a restart`, {
    ids: staleIds,
  });
}

async function tick() {
  // Per-thread serialization: fetch all currently-running assistant rows so we
  // know which threads are already busy. A queued row must not be claimed if its
  // thread already has a running row owned by anyone (including other runner
  // processes that are live-heartbeating their lease).
  const { data: runningRows, error: runErr } = await supabase
    .from("messages")
    .select("thread_id")
    .eq("role", "assistant")
    .eq("status", "running");
  if (runErr) {
    console.error(`[chat-runner] running-set fetch error: ${runErr.message}`);
    return;
  }
  const busyThreads = new Set((runningRows ?? []).map((r) => r.thread_id));

  const { data, error } = await supabase
    .from("messages")
    .select("id, thread_id")
    .eq("role", "assistant")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) {
    console.error(`[chat-runner] poll error: ${error.message}`);
    return;
  }
  // Track threads claimed within this tick so only one queued row per thread
  // is dispatched per poll cycle (strict FIFO within a thread).
  const claimedThisTick = new Set();
  for (const row of data ?? []) {
    if (inflight.has(row.id)) continue;
    // Skip if this thread already has a running turn (from a previous tick or
    // from another runner process) or if we already claimed a row for this
    // thread earlier in the current tick.
    if (busyThreads.has(row.thread_id) || claimedThisTick.has(row.thread_id)) continue;
    // Atomic claim: queued -> running only if still queued (single-winner).
    // Sets the lease (locked_at/locked_by) in the same update so a concurrent
    // runner that polls before we finish can see a fresh lease and not steal it.
    const { data: claimed } = await supabase
      .from("messages")
      .update({ status: "running", locked_at: new Date().toISOString(), locked_by: RUNNER_ID })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    claimedThisTick.add(row.thread_id);
    inflight.add(row.id);
    runOne(row.thread_id, row.id).finally(() => inflight.delete(row.id));
  }
}

console.log(`[chat-runner] up — id=${RUNNER_ID.slice(0, 8)}, polling every ${POLL_MS}ms, core=${APP_URL}, stale=${STALE_MS / 60000}min`);
await recoverOrphans();
setInterval(() => {
  tick().catch((e) => console.error(`[chat-runner] tick: ${e.message}`));
}, POLL_MS);
