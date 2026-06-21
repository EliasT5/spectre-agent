/**
 * Jerome Monitor Agent — oneshot, triggered by jerome-monitor.timer every 5 min.
 *
 * Flow:
 *   1. Collect vitals (services, logs, resources, DB, providers)
 *   2. Analyze with Ollama (primary) → Gemini (fallback) → Claude Sonnet (last resort)
 *   3. For each issue:
 *        restart_service      → systemctl restart (with 30-min cooldown)
 *        create_workshop_task → insert [proposal] into workshop_tasks
 *        escalate             → smarter model diagnoses → workshop task if fixable
 *        no_action            → log only
 *   4. Write every event to monitor_events for the UI + audit trail
 */

import { createClient } from "@supabase/supabase-js";
import { collectVitals } from "./checks.mjs";
import {
  analyzeWithOllama,
  analyzeWithGemini,
  analyzeWithClaude,
  escalateWithGemini,
  escalateWithClaude,
} from "./llm.mjs";
import {
  canRestartService,
  restartService,
  createWorkshopTask,
  logEvent,
} from "./actions.mjs";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[monitor] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Analysis with fallback cascade ────────────────────────────────────────────

async function analyze(vitals) {
  // Primary: Ollama (local, free)
  try {
    const result = await analyzeWithOllama(vitals);
    console.log("[monitor] Analysis source: ollama");
    return { source: "ollama", ...result };
  } catch (err) {
    console.warn("[monitor] Ollama unavailable:", err.message);
  }

  // Fallback: Gemini CLI (free via subscription)
  try {
    const result = await analyzeWithGemini(vitals);
    console.log("[monitor] Analysis source: gemini");
    return { source: "gemini", ...result };
  } catch (err) {
    console.warn("[monitor] Gemini unavailable:", err.message);
  }

  // Last resort: Claude Sonnet via CLI
  try {
    const result = await analyzeWithClaude(vitals);
    console.log("[monitor] Analysis source: claude");
    return { source: "claude", ...result };
  } catch (err) {
    console.warn("[monitor] Claude unavailable:", err.message);
  }

  return null;
}

// ── Escalation ────────────────────────────────────────────────────────────────

async function escalate(vitals, issue) {
  // Try Gemini first (free), then Claude
  try {
    return await escalateWithGemini(vitals, issue);
  } catch (err) {
    console.warn("[monitor] Gemini escalation failed:", err.message);
  }
  try {
    return await escalateWithClaude(vitals, issue);
  } catch (err) {
    console.warn("[monitor] Claude escalation failed:", err.message);
  }
  return null;
}

// ── Issue handler ─────────────────────────────────────────────────────────────

async function handleIssue(vitals, issue) {
  const { severity, component, description, action, params = {} } = issue;
  let actionResult = "no_action";

  if (action === "restart_service") {
    const name = params.name;
    if (!name) {
      actionResult = "skipped: no service name in params";
    } else if (!(await canRestartService(db, name))) {
      actionResult = `skipped: cooldown active or service not restartable (${name})`;
    } else {
      try {
        await restartService(name);
        actionResult = `restarted ${name}`;
        console.log(`[monitor] Restarted service: ${name}`);
      } catch (err) {
        actionResult = `restart failed: ${err.message}`;
        console.error(`[monitor] Restart failed for ${name}:`, err.message);
      }
    }

  } else if (action === "create_workshop_task") {
    const title = params.title || `[proposal] monitor: ${description.slice(0, 80)}`;
    const body  = params.body  || description;
    try {
      const id = await createWorkshopTask(db, title, body);
      actionResult = `workshop task created: ${id}`;
      console.log(`[monitor] Created workshop task: ${id}`);
    } catch (err) {
      actionResult = `workshop task failed: ${err.message}`;
      console.error("[monitor] createWorkshopTask failed:", err.message);
    }

  } else if (action === "escalate") {
    console.log(`[monitor] Escalating issue: ${component} — ${description}`);
    const escalation = await escalate(vitals, issue);

    if (escalation?.workshop_task) {
      const { title, body } = escalation.workshop_task;
      try {
        const id = await createWorkshopTask(db, title, body);
        actionResult = `escalated (${escalation.source}) → workshop task ${id}`;
        console.log(`[monitor] Escalation → workshop task ${id} via ${escalation.source}`);
      } catch (err) {
        actionResult = `escalation workshop task failed: ${err.message}`;
      }
    } else if (escalation) {
      actionResult = `escalated (${escalation.source}) → no actionable fix: ${escalation.diagnosis?.slice(0, 120)}`;
    } else {
      actionResult = "escalation: all LLMs unavailable";
    }

  } else {
    actionResult = "no_action";
  }

  await logEvent(db, {
    severity,
    component,
    description,
    action_taken: action,
    action_result: actionResult,
    raw_vitals: vitals,
    analysis: issue,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[monitor] Starting — collecting vitals...");
  const vitals = await collectVitals(db);
  console.log("[monitor] Vitals:", JSON.stringify(vitals, null, 2));

  const result = await analyze(vitals);

  if (!result) {
    // All LLMs unavailable — still log raw vitals so the UI isn't blind
    await logEvent(db, {
      severity: "warning",
      component: "monitor",
      description: "All LLM providers unavailable — raw vitals logged without analysis",
      action_taken: "no_action",
      action_result: "llm-unavailable",
      raw_vitals: vitals,
      analysis: null,
    });
    console.log("[monitor] Done (no LLM available, raw vitals logged).");
    return;
  }

  const issues = result.issues ?? [];
  console.log(`[monitor] Analysis: healthy=${result.healthy}, issues=${issues.length}`);

  if (issues.length === 0) {
    await logEvent(db, {
      severity: "info",
      component: "system",
      description: "All systems healthy",
      action_taken: "no_action",
      action_result: "ok",
      raw_vitals: vitals,
      analysis: result,
    });
  } else {
    for (const issue of issues) {
      await handleIssue(vitals, issue);
    }
  }

  console.log("[monitor] Done.");
}

main().catch((err) => {
  console.error("[monitor] Fatal:", err);
  process.exit(1);
});
