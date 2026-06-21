/**
 * LLM layer for the monitor agent.
 *
 * Primary:   Ollama (qwen2.5:7b-instruct) — local, zero cost
 * Fallback:  Gemini CLI — free via subscription
 * Last resort: Claude Sonnet via CLI — paid, only if ANTHROPIC_API_KEY set or claude bin available
 *
 * The monitor NEVER runs agentic tool loops — only one-shot prompts.
 */

import { spawn } from "child_process";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.MONITOR_OLLAMA_MODEL || "qwen2.5:7b-instruct";
const GEMINI_BIN = process.env.GEMINI_CLI_BIN || "gemini";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const ESCALATION_MODEL = process.env.MONITOR_ESCALATION_MODEL || "claude-sonnet-4-6";

// The subscription CLIs are off by default (opt-in only). The monitor's
// primary path is local Ollama; these CLI fallbacks must NOT spawn unless the
// operator opted in via the same gates the rest of Spectre uses. When a gate is
// off the function throws and monitor.mjs's try/catch cascade falls through —
// so an Ollama-down monitor cron never silently drives a personal subscription.
const GEMINI_CLI_ALLOWED = process.env.SPECTRE_ALLOW_GEMINI_CLI === "1";
const CLAUDE_CLI_ALLOWED = process.env.SPECTRE_ALLOW_CLAUDE_CLI === "1";

// ── Prompt templates ──────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `\
You are Jerome's internal monitor agent. Your job is to analyze system vitals \
and output a structured list of issues (or confirm health). \
You output raw JSON only — no markdown, no explanation, no code fences.`;

function buildAnalysisPrompt(vitals) {
  return `\
Analyze these Jerome system vitals and return a JSON object matching exactly this schema:

{
  "healthy": boolean,
  "issues": [
    {
      "severity": "info" | "warning" | "critical",
      "component": string,
      "description": string,
      "action": "restart_service" | "create_workshop_task" | "escalate" | "no_action",
      "params": {
        "name": string,        // for restart_service: the exact service name
        "title": string,       // for create_workshop_task: start with "[proposal] monitor: "
        "body": string         // for create_workshop_task: detailed description
      }
    }
  ]
}

Decision rules:
- "restart_service": only for services with expected="required" AND actual!="active" AND watchdog=false.
  Use the exact service name from the vitals. Never restart a service with watchdog=true —
  its own watchdog already handles the restart. Optional services are never restarted.
- "create_workshop_task": for config issues, env var problems, performance concerns, or recoverable
  errors that need a human-approved fix. Do NOT suggest rewriting application code.
- "escalate": for complex log errors you cannot diagnose — a smarter model will investigate.
- "no_action": for optional services being inactive, expired-but-known issues, or info observations.
- Services with expected="optional" being inactive are NEVER problems.
- workshop.stale_running > 0 means a workshop task has been running > 30 min — that is notable.
- app.claudeTokenStatus "soon" or "expired" warrants a "create_workshop_task" reminder.
- resources.disk_used_pct > 85 is a warning; > 95 is critical.
- resources.mem_available_mb < 500 is a warning; < 200 is critical.
- errors_last_10m that contain "FATAL", "OOM", "panic", or stack traces warrant "escalate".
- If everything is fine, return {"healthy": true, "issues": []}.

System vitals:
${JSON.stringify(vitals, null, 2)}`;
}

function buildEscalationPrompt(vitals, ollamaIssue) {
  return `\
You are Jerome's monitor escalation agent. Ollama flagged this issue as needing expert diagnosis:

Issue: ${JSON.stringify(ollamaIssue, null, 2)}

System vitals:
${JSON.stringify(vitals, null, 2)}

Diagnose the root cause. If a fix exists that does NOT require rewriting application source code \
(e.g. env var change, config file edit, service restart sequence, data cleanup), \
describe it as a workshop task that a code agent can execute.

Respond in raw JSON only:
{
  "diagnosis": string,
  "fixable_without_code_change": boolean,
  "workshop_task": {
    "title": "[proposal] monitor: ...",
    "body": "Detailed steps for the workshop agent to execute"
  } | null
}`;
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

function runProcess(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${opts.timeout ?? 120}s`));
    }, (opts.timeout ?? 120) * 1000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.slice(-500) || `${bin} exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function extractJson(text) {
  // Strips markdown fences if the model wrapped its JSON anyway
  const clean = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object found in output: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

// ── Primary: Ollama ───────────────────────────────────────────────────────────

export async function analyzeWithOllama(vitals) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM },
        { role: "user",   content: buildAnalysisPrompt(vitals) },
      ],
      options: { temperature: 0.05, num_predict: 1024 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const content = data.message?.content ?? "{}";

  try {
    return extractJson(content);
  } catch {
    throw new Error(`Ollama returned unparseable JSON: ${content.slice(0, 300)}`);
  }
}

// ── Fallback: Gemini CLI ──────────────────────────────────────────────────────

export async function analyzeWithGemini(vitals) {
  if (!GEMINI_CLI_ALLOWED) throw new Error("gemini CLI disabled (SPECTRE_ALLOW_GEMINI_CLI off — ToS-gated)");
  const prompt = `${ANALYSIS_SYSTEM}\n\n${buildAnalysisPrompt(vitals)}`;
  const out = await runProcess(
    GEMINI_BIN,
    ["--skip-trust", "-o", "text", "-p", prompt],
    { timeout: 90 }
  );
  return extractJson(out);
}

// ── Last resort: Claude CLI ───────────────────────────────────────────────────

export async function analyzeWithClaude(vitals) {
  if (!CLAUDE_CLI_ALLOWED) throw new Error("claude CLI disabled (SPECTRE_ALLOW_CLAUDE_CLI off — ToS-gated)");
  const prompt = `${ANALYSIS_SYSTEM}\n\n${buildAnalysisPrompt(vitals)}`;
  const out = await runProcess(
    CLAUDE_BIN,
    ["--print", "--model", ESCALATION_MODEL, prompt],
    { timeout: 90 }
  );
  return extractJson(out);
}

// ── Escalation (called per-issue when Ollama says "escalate") ─────────────────

export async function escalateWithGemini(vitals, issue) {
  if (!GEMINI_CLI_ALLOWED) throw new Error("gemini CLI disabled (SPECTRE_ALLOW_GEMINI_CLI off — ToS-gated)");
  const prompt = buildEscalationPrompt(vitals, issue);
  const out = await runProcess(
    GEMINI_BIN,
    ["--skip-trust", "-o", "text", "-p", prompt],
    { timeout: 120 }
  );
  return { source: "gemini", ...extractJson(out) };
}

export async function escalateWithClaude(vitals, issue) {
  if (!CLAUDE_CLI_ALLOWED) throw new Error("claude CLI disabled (SPECTRE_ALLOW_CLAUDE_CLI off — ToS-gated)");
  const prompt = buildEscalationPrompt(vitals, issue);
  const out = await runProcess(
    CLAUDE_BIN,
    ["--print", "--model", ESCALATION_MODEL, prompt],
    { timeout: 120 }
  );
  return { source: "claude", ...extractJson(out) };
}
