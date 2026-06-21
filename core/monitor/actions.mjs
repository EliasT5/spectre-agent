/**
 * Side-effect actions the monitor can take.
 * Each action is bounded and reversible — no code changes, no data deletion.
 */

import { promisify } from "util";
import { exec } from "child_process";
import { SERVICE_CONFIG } from "./checks.mjs";

const execAsync = promisify(exec);

// Services the monitor is allowed to restart: every operator-configured service
// (SPECTRE_MONITORED_SERVICES) that is "required" and NOT watchdog-managed.
// Watchdog-managed services are intentionally excluded — their own watchdog
// owns the restart.
const RESTARTABLE = new Set(
  Object.entries(SERVICE_CONFIG)
    .filter(([, cfg]) => cfg.expected === "required" && !cfg.watchdog)
    .map(([name]) => name)
);

const RESTART_COOLDOWN_MINUTES = 30;

export async function canRestartService(db, name) {
  if (!RESTARTABLE.has(name)) return false;
  const since = new Date(Date.now() - RESTART_COOLDOWN_MINUTES * 60_000).toISOString();
  const { count } = await db
    .from("monitor_events")
    .select("id", { count: "exact", head: true })
    .eq("component", name)
    .eq("action_taken", "restart_service")
    .gte("created_at", since);
  return (count ?? 0) === 0;
}

export async function restartService(name) {
  if (!RESTARTABLE.has(name)) {
    throw new Error(`"${name}" is not in the monitor's restartable whitelist`);
  }
  if (process.platform !== "linux") {
    throw new Error("restartService is only available on Linux");
  }
  const { stderr } = await execAsync(`systemctl restart ${name}`, { timeout: 30_000 });
  return stderr.trim() || "ok";
}

export async function createWorkshopTask(db, title, body) {
  const { data, error } = await db
    .from("workshop_tasks")
    .insert({ title, description: body, status: "pending" })
    .select("id")
    .single();
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  return data.id;
}

export async function logEvent(db, event) {
  const { error } = await db.from("monitor_events").insert({
    severity:      event.severity ?? "info",
    component:     event.component ?? "system",
    description:   event.description ?? "",
    action_taken:  event.action_taken ?? "no_action",
    action_result: event.action_result ?? null,
    raw_vitals:    event.raw_vitals ?? null,
    analysis:      event.analysis ?? null,
  });
  if (error) console.error("[monitor] logEvent failed:", error.message);
}
