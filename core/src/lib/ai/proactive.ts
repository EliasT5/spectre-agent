/**
 * Proactive heartbeat — periodically asks Haiku whether Jerome should
 * propose any workshop tasks. Insertions land in `workshop_tasks` with
 * a `[proposal]` title prefix; the worker skips these until a human
 * accepts (via UI), at which point the prefix is stripped and the
 * realtime listener picks the task up like any other.
 *
 * Called by:
 *   - POST /api/heartbeat/propose        (manual / systemd-timer driven)
 *   - eventually a nightly scheduler     (see REWORK_PLAN.md phase 3b)
 *
 * Design choice: we reuse `workshop_tasks` with a naming convention
 * instead of adding a `proposed` status (would need a schema migration
 * and a CHECK-constraint update). Convention stays as long as the
 * worker's skip predicate does — see worker/worker.mjs parseProposal.
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { streamLiteLLM, quickCompleteLiteLLM } from "@/lib/ai/providers/litellm";
import { abortThread } from "@/lib/ai/abort";
import { getModel, type ModelDef } from "@/lib/ai/models";
import { persistProactivePolicy } from "@/lib/permission/broker";
import { reportEvent } from "@/lib/monitor/report";
import { visibleToolName } from "@/lib/ai/mcp-catalog";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const REPO_PATH = process.env.SPECTRE_REPO_PATH || process.cwd();
const PROPOSAL_PREFIX = "[proposal]";

// ---------------------------------------------------------------------------
// P1.1 — Bounded proactive run (real tools + memory, safe whitelist).
//
// The proposal-only heartbeat (quickCompleteLiteLLM) is tool-blind and only PROPOSES
// workshop tasks. The bounded run below gives the brain a SAFE, read-mostly
// MCP tool surface and lets it ACT on its own within hard limits — all on the
// provider-agnostic LiteLLM brain (the opt-in Claude CLI is never used here):
//   - WHITELIST: only the catalog keys in PROACTIVE_TOOL_KEYS. The whitelist is
//     enforced structurally via streamLiteLLM's toolAllowlist, so the brain
//     CANNOT call bash/write/edit or any workshop-mutation tool —
//     they're simply never exposed in its tool list.
//   - PRE-SEEDED POLICY: before the run we write short-TTL `always_allow` thread
//     policies (with a per-tool hourly quota) so any whitelisted tool that DOES
//     route through the permission gate (autonomous:true) auto-resolves instead
//     of hanging on a human prompt no one will answer.
//   - WALL-CLOCK BUDGET: at PROACTIVE_RUN_MS we abortThread(), tearing down the
//     stream + broker; a budget cut-off resolves with whatever was produced.
//   - GRACEFUL DEGRADATION: if the tool_policies table isn't applied yet (DB
//     error on pre-seed), we fall back to the proposal-only heartbeat rather
//     than starting a tool-enabled run whose gated calls might block.
// ---------------------------------------------------------------------------

/** Catalog keys (dot form) the proactive brain may use. SAFE only: memory
 *  read/write, notify (push), schedule READ, calendar READ, analytics READ.
 *  NEVER bash/write/edit, schedule mutation, or any workshop tool. */
const PROACTIVE_TOOL_KEYS = [
  "memory.add",
  "memory.search",
  "notify",
  "schedule.list",
  "schedule.get",
  "analytics.usage",
  "calendar.today",
  "calendar.upcoming",
] as const;

/** Per-tool trailing-hour quota for the pre-seeded policies. Memory is
 *  unbounded (cheap, idempotent-ish); everything else (notify especially) is
 *  capped so a runaway loop can't spam the user. */
function quotaForTool(key: string): number | null {
  if (key.startsWith("memory.")) return null;
  if (key === "notify") return 3;
  return 10;
}

const PROACTIVE_THREAD_TITLE = "Jerome Proactive Brain";
const PROACTIVE_POLICY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — re-seeded each run
const PROACTIVE_RUN_MS = Number(process.env.SPECTRE_PROACTIVE_RUN_MS || 120_000);

export interface ProactiveBoundedResult {
  /** "tools" when the bounded tool-using run executed, "proposal" when it
   *  degraded to the legacy heartbeat. */
  mode: "tools" | "proposal";
  threadId: string | null;
  output: string;
  /** Whitelisted tool calls observed in the run's stream-json output. */
  toolCalls: number;
  degraded: boolean;
  error?: string;
  /** Present only when degraded — the proposal-only heartbeat result. */
  proposal?: ProactiveResult;
}

export interface HeartbeatProposal {
  title: string;
  description: string;
}

export interface ProactiveResult {
  proposals: HeartbeatProposal[];
  raw: string;
  inserted: number;
  skippedExisting: number;
  error?: string;
}


/**
 * Parse Haiku's output. We ask for one proposal per line:
 *   - <title> :: <one-line description>
 * Lines without `::` or empty are ignored.
 */
function parseProposals(raw: string): HeartbeatProposal[] {
  const out: HeartbeatProposal[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/^\s*[-*]\s*/, "").trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("::");
    if (sep < 0) continue;
    const title = trimmed.slice(0, sep).trim();
    const description = trimmed.slice(sep + 2).trim();
    if (!title || !description) continue;
    out.push({ title, description });
  }
  return out;
}

export type ProactiveMode = "heartbeat" | "dream";

function buildPrompt(mode: ProactiveMode, ctx: {
  tasks: { title: string | null; status: string | null }[];
  existingProposals: Set<string>;
  soulSnapshot: string;
  skillsListing: string;
  heartbeatNotes: string;
}): string {
  const shared = `OUTPUT FORMAT — strictly one proposal per line, up to 3 total:
  <short imperative title> :: <one-sentence description>

Rules:
- Imperative, verb-first titles.
- Max 3 proposals. Fewer is better. Output just "NONE" on a single line if nothing is worth doing.
- Never propose anything from the EXISTING list below.
- Base proposals only on the context below. You have no tool access.

EXISTING PROPOSAL TITLES (do NOT repeat):
${[...ctx.existingProposals].map((t) => `- ${t}`).join("\n") || "(none)"}`;

  if (mode === "dream") {
    return `You are Jerome's memory curator running a /dream pass. Your job is to propose consolidations of Jerome's own persona and memory files so they stay sharp.

${shared}

SOUL DIRECTORY SNAPSHOT:
${ctx.soulSnapshot || "(empty)"}

SKILLS AVAILABLE:
${ctx.skillsListing || "(none)"}

Look for: overlapping content between soul files, stale references, skills with no matching behaviour, sections that should be split into topic files, or places where the tone drifts. Propose merges, archives, splits, or rewrites.

Begin now.`;
  }

  // heartbeat (default)
  return `You are Jerome's proactive heartbeat. Decide whether to propose any maintenance work.

${shared}

RECENT WORKSHOP ACTIVITY (last 20):
${ctx.tasks
  .map((t) => `- [${t.status ?? "?"}] ${t.title ?? "(untitled)"}`)
  .join("\n") || "(none)"}

SOUL DIRECTORY SNAPSHOT (first ~1.5 KB of each file):
${ctx.soulSnapshot || "(empty)"}

SKILLS AVAILABLE:
${ctx.skillsListing || "(none)"}

${ctx.heartbeatNotes ? `HEARTBEAT NOTES:\n${ctx.heartbeatNotes}\n` : ""}

Begin now.`;
}

export async function runProactiveHeartbeat(
  mode: ProactiveMode = "heartbeat"
): Promise<ProactiveResult> {
  const supabase = createServiceSupabase();

  // Load a compact context so Haiku isn't shooting in the dark:
  //   - Open PRs / recent commits (via gh), skipped here to keep it fast
  //   - Current proposals so we don't double-propose
  //   - Recent completed / failed workshop tasks
  //   - Soul HEARTBEAT.md notes if present
  const { data: recentTasks } = await supabase
    .from("workshop_tasks")
    .select("title, status, created_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(20);

  type TaskRow = { title: string | null; status: string | null };
  const tasks = (recentTasks ?? []) as TaskRow[];
  const existingProposals = new Set(
    tasks
      .filter((t) => t.title?.startsWith(PROPOSAL_PREFIX))
      .map((t) => (t.title ?? "").replace(PROPOSAL_PREFIX, "").trim().toLowerCase())
  );

  // Pre-load the repo context Haiku would otherwise fetch via tool calls.
  // Staying under ~15 KB keeps TTFT low.
  function readDirTrimmed(dir: string, cap = 4000): string {
    try {
      const entries = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      const chunks: string[] = [];
      let total = 0;
      for (const name of entries) {
        const p = join(dir, name);
        try {
          const s = statSync(p);
          if (!s.isFile()) continue;
          const body = readFileSync(p, "utf-8");
          const head = `=== ${name} (${body.length} bytes) ===\n${body.slice(0, Math.min(body.length, 1500))}`;
          chunks.push(head);
          total += head.length;
          if (total >= cap) break;
        } catch {
          /* skip */
        }
      }
      return chunks.join("\n\n");
    } catch {
      return "";
    }
  }

  const soulSnapshot = readDirTrimmed(join(REPO_PATH, "soul"));
  const skillsDir = join(REPO_PATH, "skills");
  let skillsListing = "";
  try {
    skillsListing = readdirSync(skillsDir).sort().join(", ");
  } catch {
    /* skills dir may not exist */
  }

  let heartbeatNotes = "";
  try {
    heartbeatNotes = readFileSync(join(REPO_PATH, "soul", "HEARTBEAT.md"), "utf-8").slice(0, 4000);
  } catch {
    /* optional */
  }

  const prompt = buildPrompt(mode, {
    tasks,
    existingProposals,
    soulSnapshot,
    skillsListing,
    heartbeatNotes,
  });

  let raw = "";
  try {
    // Tool-less completion on the provider-agnostic brain (LiteLLM), NOT the
    // opt-in Claude CLI — the heartbeat embeds all context in the prompt.
    raw = await quickCompleteLiteLLM(prompt);
  } catch (err) {
    return {
      proposals: [],
      raw: "",
      inserted: 0,
      skippedExisting: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (/^\s*NONE\b/im.test(raw)) {
    return { proposals: [], raw, inserted: 0, skippedExisting: 0 };
  }

  const proposals = parseProposals(raw);
  let inserted = 0;
  let skippedExisting = 0;

  for (const p of proposals) {
    const titleKey = p.title.toLowerCase();
    if (existingProposals.has(titleKey)) {
      skippedExisting++;
      continue;
    }
    const { error } = await supabase.from("workshop_tasks").insert({
      title: `${PROPOSAL_PREFIX} ${p.title}`,
      description: p.description,
      status: "pending",
    });
    if (!error) inserted++;
  }

  return { proposals, raw, inserted, skippedExisting };
}

// ===========================================================================
// P1.1 — Bounded proactive run with real tools + memory
// ===========================================================================

/**
 * Find (or create once) the single durable thread the proactive brain runs in.
 * A fixed thread gives the brain conversational continuity across runs and is
 * the scope the pre-seeded tool policies key off. Returns null on DB error so
 * the caller can degrade gracefully.
 */
async function getOrCreateProactiveThread(): Promise<string | null> {
  try {
    const supabase = createServiceSupabase();
    const { data: existing } = await supabase
      .from("threads")
      .select("id")
      .eq("title", PROACTIVE_THREAD_TITLE)
      .eq("archived", false)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing && (existing as { id: string }).id) {
      return (existing as { id: string }).id;
    }

    const { data: created, error } = await supabase
      .from("threads")
      .insert({ title: PROACTIVE_THREAD_TITLE, metadata: { type: "proactive" } })
      .select("id")
      .single();
    if (error || !created) return null;
    return (created as { id: string }).id;
  } catch {
    return null;
  }
}

/** Compact, self-contained context + instructions for the tool-using run. */
function buildBoundedPrompt(ctx: {
  tasks: { title: string | null; status: string | null }[];
  recentIssues: string;
}): string {
  const taskLines =
    ctx.tasks
      .map((t) => `- [${t.status ?? "?"}] ${t.title ?? "(untitled)"}`)
      .join("\n") || "(none)";

  return `You are Jerome's proactive autonomous agent, running a short, bounded background turn (not a live chat with the user — they are away).

You have a SMALL, SAFE toolset: long-term memory (read + write), push notification, schedule listing (read-only), calendar (read-only), and model-usage analytics (read-only). You do NOT have shell, file edit/write, or any workshop/deployment tools — do not attempt them.

YOUR JOB — pick AT MOST ONE genuinely useful action, then stop:
1. Search your memory (the memory_search tool) for relevant context before deciding anything.
2. Look for something concrete worth doing on your own, e.g.:
   - Record a durable fact you can infer is worth remembering (the memory_add tool).
   - Notice a calendar conflict or an unusual usage/cost spike worth surfacing.
   - Only if it is genuinely time-sensitive and useful, send ONE push (the notify tool). Do NOT notify just to say hello — silence is the correct default.
3. If nothing is worth doing, take no action. That is a good outcome — do not invent busywork.

Be terse. Explain your reasoning in one or two sentences BEFORE any tool call. Make at most a couple of tool calls total. When done, end with a one-line summary of what (if anything) you did.

RECENT WORKSHOP ACTIVITY (last 20):
${taskLines}

${ctx.recentIssues ? `RECENT SYSTEM ISSUES:\n${ctx.recentIssues}\n` : ""}Begin now.`;
}

/**
 * Drive a single tool-enabled turn on the provider-agnostic brain (LiteLLM) and
 * collect (a) the concatenated assistant text and (b) a count of whitelisted
 * tool calls. The opt-in Claude CLI is NOT used here.
 *
 * Safety is structural + governed:
 *   - toolAllowlist restricts the broker tools EXPOSED to the model to the safe
 *     whitelist — anything else simply isn't offered (the CLI's --allowed-tools
 *     equivalent), so the model can't call bash/write/edit/workshop tools.
 *   - autonomous:true makes the broker enforce the pre-seeded hourly quota
 *     policies through the permission gate instead of prompting a human.
 *   - A hard wall-clock budget: at PROACTIVE_RUN_MS we abortThread(), which fires
 *     the litellm provider's registered teardown (abort the stream + close the
 *     broker). A budget cut-off is a normal bound, so we resolve with whatever we
 *     collected rather than surfacing the abort as an error.
 */
async function runBoundedTurn(
  threadId: string,
  systemPrompt: string,
  prompt: string,
): Promise<{ output: string; toolCalls: number }> {
  const allowed = new Set<string>(PROACTIVE_TOOL_KEYS);
  // litellm-default fronts whatever SPECTRE_LITELLM_MODEL points at; the provider
  // reads model.maxOutputTokens + (cliModel||env||id) for the model string.
  const model: ModelDef = getModel("litellm-default") ?? {
    id: "litellm-default",
    provider: "litellm",
    displayName: "Spectre (LiteLLM)",
    strengths: [],
    bestFor: [],
    costTier: 3,
    speed: 3,
    maxOutputTokens: 1024,
    contextWindow: 128_000,
  };

  let output = "";
  let toolCalls = 0;
  let timedOut = false;
  const budget = setTimeout(() => {
    timedOut = true;
    abortThread(threadId);
  }, PROACTIVE_RUN_MS);

  try {
    for await (const chunk of streamLiteLLM({
      threadId,
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      toolAllowlist: [...PROACTIVE_TOOL_KEYS],
      autonomous: true,
    })) {
      if (chunk.type === "token") {
        output += chunk.text;
      } else if (chunk.type === "tool_use" && allowed.has(chunk.name)) {
        toolCalls++;
      }
    }
  } catch (err) {
    // A budget cut-off aborts the stream — that's a normal bound, not a failure.
    if (!timedOut) throw err;
  } finally {
    clearTimeout(budget);
  }

  return { output: output.trim(), toolCalls };
}

/**
 * The P1.1 entry point. Pre-seeds safe-whitelist policies, runs ONE bounded
 * tool-enabled turn, and captures the outcome to monitor_events. Degrades to
 * the proposal-only heartbeat if the thread can't be resolved or the policy
 * table isn't applied yet (so a tool call can never hang on a human prompt).
 *
 * Called by the scheduler "proactive" job via /api/proactive/bounded-run.
 */
export async function runProactiveBoundedRun(): Promise<ProactiveBoundedResult> {
  const threadId = await getOrCreateProactiveThread();

  // No thread → can't scope policies → degrade.
  if (!threadId) {
    const proposal = await runProactiveHeartbeat("heartbeat");
    await reportEvent({
      severity: "info",
      component: "proactive:bounded-run",
      description:
        "Degraded to proposal-only: could not resolve proactive thread (DB?).",
      detail: { inserted: proposal.inserted, skipped: proposal.skippedExisting },
    });
    return {
      mode: "proposal",
      threadId: null,
      output: proposal.raw,
      toolCalls: 0,
      degraded: true,
      error: "no proactive thread",
      proposal,
    };
  }

  // Pre-seed always_allow policies (TTL + per-tool hourly quota) so any
  // whitelisted tool that routes through the permission gate auto-resolves.
  // If the table isn't applied yet, persistProactivePolicy throws → degrade.
  try {
    for (const key of PROACTIVE_TOOL_KEYS) {
      await persistProactivePolicy({
        tool: visibleToolName(key),
        scopeId: threadId,
        ttlMs: PROACTIVE_POLICY_TTL_MS,
        quotaPerHour: quotaForTool(key),
      });
    }
  } catch (err) {
    const proposal = await runProactiveHeartbeat("heartbeat");
    await reportEvent({
      severity: "warning",
      component: "proactive:bounded-run",
      description: `Policy pre-seed failed; degraded to proposal-only: ${
        err instanceof Error ? err.message : String(err)
      }`,
      threadId,
      detail: { inserted: proposal.inserted, skipped: proposal.skippedExisting },
    });
    return {
      mode: "proposal",
      threadId,
      output: proposal.raw,
      toolCalls: 0,
      degraded: true,
      error: err instanceof Error ? err.message : String(err),
      proposal,
    };
  }

  // Load a compact context (same shape the heartbeat uses) for the prompt.
  let tasks: { title: string | null; status: string | null }[] = [];
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase
      .from("workshop_tasks")
      .select("title, status")
      .order("created_at", { ascending: false })
      .limit(20);
    tasks = (data ?? []) as { title: string | null; status: string | null }[];
  } catch {
    /* context is best-effort */
  }

  let issuesBlock = "";
  try {
    const { recentIssues, buildIssuesBlock } = await import("@/lib/monitor/report");
    issuesBlock = buildIssuesBlock(await recentIssues(60, 5)).trim();
  } catch {
    /* optional */
  }

  const systemPrompt =
    "You are Jerome's proactive autonomous agent. You act on your own in short bounded background turns with a small, safe toolset. You ALWAYS explain your reasoning in one sentence before any tool call, you prefer doing nothing over doing busywork, and you NEVER attempt tools outside the ones you were given.";
  const prompt = buildBoundedPrompt({ tasks, recentIssues: issuesBlock });

  try {
    const { output, toolCalls } = await runBoundedTurn(threadId, systemPrompt, prompt);
    await reportEvent({
      severity: "info",
      component: "proactive:bounded-run",
      description: `Bounded proactive run completed: tool_calls=${toolCalls}, output_len=${output.length}`,
      threadId,
      detail: { toolCalls, outputPreview: output.slice(0, 400) },
    });
    return { mode: "tools", threadId, output, toolCalls, degraded: false };
  } catch (err) {
    await reportEvent({
      severity: "warning",
      component: "proactive:bounded-run",
      description: `Bounded proactive run failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      threadId,
    });
    return {
      mode: "tools",
      threadId,
      output: "",
      toolCalls: 0,
      degraded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
