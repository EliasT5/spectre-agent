/**
 * Spectre updater sidecar — the host-executor that lets the SHELL apply updates
 * with a BUTTON (no terminal). A container can't rebuild itself, so this small
 * service mounts the host Docker socket + the repo and drives the SAME host
 * updater script (scripts/spectre-update.mjs) on demand and on a schedule.
 *
 * PRIVILEGE: it can run Docker on the host (≈ host root). It is OFF by default
 * (compose `update` profile), internal-only (no published port), and every route
 * is gated by UPDATER_TOKEN. The core proxies the PIN-gated shell to it.
 *
 * Routes (all except /health require `x-updater-token`):
 *   GET  /health         → { ok }
 *   GET  /status         → { state, target, startedAt, finishedAt, exitCode, log }
 *   POST /apply {target}  → start `spectre-update.mjs --apply --target <t>` (409 if busy)
 * Plus a background auto-loop running `spectre-update.mjs --auto` (per-target
 * settings decide what, if anything, is applied).
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT) || 8020;
const TOKEN = process.env.UPDATER_TOKEN || "";
const REPO = process.env.REPO_DIR || "/repo";
const SCRIPT = `${REPO}/scripts/spectre-update.mjs`;
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_LOG_LINES = 400;

/** Single in-flight job at a time. */
const job = {
  state: "idle", // "idle" | "running"
  kind: null, // "apply" | "auto"
  target: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  log: [],
};

function pushLog(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l) continue;
    job.log.push(l);
    if (job.log.length > MAX_LOG_LINES) job.log.shift();
  }
}

/** Run the host update script with the given args. Resolves with the exit code. */
function runScript(args, { kind, target }) {
  return new Promise((resolve) => {
    job.state = "running";
    job.kind = kind;
    job.target = target ?? null;
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    job.exitCode = null;
    job.log = [];
    pushLog(`$ node spectre-update.mjs ${args.join(" ")}`);

    const child = spawn("node", [SCRIPT, ...args], {
      cwd: REPO,
      // The script's health-check must target the core over the compose network,
      // not the sidecar's own loopback.
      // Point the script's health/reminders calls at the core over the compose
      // network (not the sidecar's own loopback).
      env: { ...process.env, SPECTRE_CORE_URL: process.env.SPECTRE_CORE_URL || "http://core:8787" },
    });
    child.stdout.on("data", (d) => pushLog(d.toString()));
    child.stderr.on("data", (d) => pushLog(d.toString()));
    child.on("error", (err) => pushLog(`spawn error: ${err.message}`));
    child.on("close", (code) => {
      job.state = "idle";
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      pushLog(`(exit ${code})`);
      resolve(code);
    });
  });
}

function tokenOk(req) {
  if (!TOKEN) return false;
  const got = req.headers["x-updater-token"];
  if (typeof got !== "string" || got.length !== TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(s);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return json(res, 200, { ok: true });

  if (!tokenOk(req)) return json(res, 401, { error: "unauthorized" });

  if (req.method === "GET" && url.pathname === "/status") {
    return json(res, 200, {
      state: job.state,
      kind: job.kind,
      target: job.target,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      log: job.log.slice(-120),
    });
  }

  if (req.method === "POST" && url.pathname === "/apply") {
    if (job.state === "running") return json(res, 409, { error: `busy (${job.kind} in progress)`, state: job.state });
    let body = "";
    for await (const chunk of req) body += chunk;
    let target = "both";
    try {
      const parsed = body ? JSON.parse(body) : {};
      if (parsed && typeof parsed.target === "string") target = parsed.target;
    } catch {
      /* default target */
    }
    if (!["both", "core", "shell"].includes(target)) {
      return json(res, 400, { error: "target must be both, core or shell" });
    }
    // Fire and forget — the shell polls /status for progress.
    void runScript(["--apply", "--target", target], { kind: "apply", target });
    return json(res, 202, { accepted: true, target });
  }

  return json(res, 404, { error: "not found" });
});

// Background auto-apply: the script's --auto reads the per-target reminder
// settings from the core and applies only the targets set to "auto".
async function autoTick() {
  if (job.state === "running") return; // don't overlap a manual apply
  await runScript(["--auto"], { kind: "auto", target: null });
}

server.listen(PORT, () => {
  console.log(`[spectre-updater] listening on :${PORT} (repo ${REPO})`);
  if (!TOKEN) console.warn("[spectre-updater] UPDATER_TOKEN is empty — all authed routes will 401 (fail-closed).");
  // First auto check shortly after boot, then every 6h. Fail-soft.
  setTimeout(() => void autoTick().catch(() => {}), 90_000);
  setInterval(() => void autoTick().catch(() => {}), AUTO_INTERVAL_MS);
});
