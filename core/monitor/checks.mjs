/**
 * Vitals collection — pure data gathering, no AI, no side effects.
 * Every check is independent; failures are captured as error fields, not throws.
 */

import { promisify } from "util";
import { exec } from "child_process";
import { readFileSync } from "fs";

const execAsync = promisify(exec);

const SPECTRE_APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

// Services the monitor tracks — configured by the operator, since the systemd
// unit names depend entirely on how a given deployment is wired up.
//
// Set SPECTRE_MONITORED_SERVICES to a comma-separated list of entries of the
// form `name[:expected[:watchdog]]`, e.g.
//   SPECTRE_MONITORED_SERVICES="spectre-core:required,ollama:optional"
//   - expected: "required" → alert if not active; "optional" → informational only
//     (default: "required")
//   - watchdog: "watchdog" → an external watchdog already handles restart and the
//     monitor only observes; omit otherwise (default: not a watchdog service)
//
// The default is intentionally minimal and generic so a fresh deployment monitors
// nothing host-specific until the operator opts services in.
export const SERVICE_CONFIG = parseServiceConfig(
  process.env.SPECTRE_MONITORED_SERVICES || ""
);

function parseServiceConfig(raw) {
  const config = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, expected, watchdog] = entry.split(":").map((s) => s.trim());
    if (!name) continue;
    config[name] = {
      expected: expected === "optional" ? "optional" : "required",
      watchdog: watchdog === "watchdog" || watchdog === "true",
    };
  }
  return config;
}

async function checkServices() {
  if (process.platform !== "linux") return { _note: "not-linux, skipped" };

  const results = {};
  await Promise.all(
    Object.entries(SERVICE_CONFIG).map(async ([name, cfg]) => {
      try {
        const { stdout } = await execAsync(`systemctl is-active ${name}`, { timeout: 5000 });
        results[name] = { ...cfg, actual: stdout.trim() };
      } catch (err) {
        // systemctl is-active exits 3 for inactive — stdout still has the state string
        results[name] = { ...cfg, actual: (err.stdout || "").trim() || "unknown" };
      }
    })
  );
  return results;
}

async function checkApp() {
  try {
    const res = await fetch(`${SPECTRE_APP_URL}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { reachable: true, httpStatus: res.status, status: "error" };
    const data = await res.json();
    return {
      reachable: true,
      status: data.status,
      claudeTokenStatus: data.claudeCodeToken?.status ?? "unknown",
      claudeTokenDaysRemaining: data.claudeCodeToken?.daysRemaining ?? null,
    };
  } catch {
    return { reachable: false, error: "timeout or ECONNREFUSED" };
  }
}

async function checkProviders() {
  try {
    const res = await fetch(`${SPECTRE_APP_URL}/api/models`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { active: data.providers ?? [] };
  } catch {
    return { error: "unreachable" };
  }
}

async function checkResources() {
  if (process.platform !== "linux") return { _note: "not-linux, skipped" };
  try {
    const { stdout: dfOut } = await execAsync(
      "df / --output=pcent --no-sync 2>/dev/null | tail -1",
      { timeout: 5000 }
    );
    const diskPct = parseInt(dfOut.trim().replace("%", ""), 10);

    const meminfo = readFileSync("/proc/meminfo", "utf-8");
    const parseMb = (key) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? Math.round(parseInt(m[1], 10) / 1024) : 0;
    };

    return {
      disk_used_pct: isNaN(diskPct) ? null : diskPct,
      mem_total_mb: parseMb("MemTotal"),
      mem_available_mb: parseMb("MemAvailable"),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function checkJournalErrors() {
  if (process.platform !== "linux") return [];
  const serviceNames = Object.keys(SERVICE_CONFIG);
  if (serviceNames.length === 0) return [];
  try {
    const units = serviceNames
      .map((s) => `-u ${s}`)
      .join(" ");
    const { stdout } = await execAsync(
      `journalctl ${units} --since "10 minutes ago" -p err --no-pager -o short-iso --no-hostname 2>/dev/null | tail -40`,
      { timeout: 10000 }
    );
    return stdout.trim().split("\n").filter(Boolean).slice(-20);
  } catch {
    return [];
  }
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { available: false };
    const data = await res.json();
    return {
      available: true,
      models: (data.models ?? []).map((m) => m.name),
    };
  } catch {
    return { available: false, models: [] };
  }
}

async function checkClaudeBin() {
  const bin = process.env.CLAUDE_BIN || "claude";
  try {
    await execAsync(`${bin} --version`, { timeout: 5000 });
    return { available: true };
  } catch {
    return { available: false };
  }
}

async function checkWorkshop(db) {
  try {
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const since30m = new Date(Date.now() - 1800000).toISOString();

    const [pending, running, failed, stale] = await Promise.all([
      db.from("workshop_tasks").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("workshop_tasks").select("id", { count: "exact", head: true }).eq("status", "running"),
      db.from("workshop_tasks")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .gte("created_at", since24h),
      // Tasks stuck in running for > 30 minutes
      db.from("workshop_tasks")
        .select("id", { count: "exact", head: true })
        .eq("status", "running")
        .lt("started_at", since30m),
    ]);

    return {
      pending: pending.count ?? 0,
      running: running.count ?? 0,
      failed_24h: failed.count ?? 0,
      stale_running: stale.count ?? 0,
    };
  } catch (err) {
    return { error: err.message };
  }
}

export async function collectVitals(db) {
  const [services, app, providers, resources, errors_last_10m, ollama, claude_bin, workshop] =
    await Promise.all([
      checkServices(),
      checkApp(),
      checkProviders(),
      checkResources(),
      checkJournalErrors(),
      checkOllama(),
      checkClaudeBin(),
      checkWorkshop(db),
    ]);

  return {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    services,
    app,
    providers,
    resources,
    errors_last_10m,
    ollama,
    claude_bin,
    workshop,
  };
}
