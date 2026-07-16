import { Hono } from "hono";
import { getGithubToken } from "@/lib/github-token";
import { reportEvent } from "@/lib/monitor/report";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getUpdateReminders,
  setUpdateReminders,
  remindersActive,
  type UpdateReminderMode,
  type UpdateTarget,
  type TargetReminders,
} from "@/lib/update-reminders";

/**
 * Update DETECTOR (notify, never auto-apply). The running image carries the git
 * SHA it was built from (SPECTRE_BUILD_SHA, baked in by scripts/spectre-update.mjs
 * → core/Dockerfile ARG). This route compares it against the latest commit on
 * origin/main via the GitHub API — the repo is PRIVATE, so the call authenticates
 * with the runtime GitHub token from Settings (lib/github-token). Applying an
 * update stays a HOST action: scripts/spectre-update.sh --apply (a container
 * can't rebuild and recreate itself).
 *
 * GET /api/update/status    → { runningSha, latestSha, behind, updateAvailable, checkedAt }
 * GET /api/update/reminders → { core: {mode,mutedUntil?}, shell: {mode,mutedUntil?} }
 * PUT /api/update/reminders → body { target: "core"|"shell", mode?, muteForMs? }
 *
 * A guarded 6-hourly background check (startUpdateCheckLoop, called from
 * main.ts) reacts when a NEW latest SHA shows up — de-duped so it reports once
 * per remote commit, not once per interval — and, when AT LEAST ONE target's
 * reminders are active (lib/update-reminders: not "off", not muted), logs an
 * info monitor event AND opens a conversational reminder chat
 * (createUpdateReminderChat) explaining per active target. Fail-soft
 * throughout: no token / API down / no SHA baked → "no update", never an error.
 */

const REPO = "EliasT5/spectre-agent";
const BRANCH = "main";

interface UpdateStatus {
  /** SHA the running core image was built from ("" in the image → null = unknown). */
  runningSha: string | null;
  /** Latest commit SHA on origin/main (null when GitHub is unreachable/unauthed). */
  latestSha: string | null;
  /** True when both SHAs are known and differ. Null when either side is unknown. */
  behind: boolean | null;
  updateAvailable: boolean;
  checkedAt: string;
  note?: string;
}

/** Latest commit SHA on main, via the GitHub API (token required — private repo). */
async function fetchLatestSha(token: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "spectre-core",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const body = (await res.json()) as { sha?: string };
  return typeof body.sha === "string" && body.sha.length > 0 ? body.sha : null;
}

/** SHAs may be baked short — treat prefix matches as equal. */
function sameCommit(a: string, b: string): boolean {
  const min = Math.min(a.length, b.length);
  return min >= 7 && a.slice(0, min) === b.slice(0, min);
}

export async function checkUpdateStatus(): Promise<UpdateStatus> {
  const checkedAt = new Date().toISOString();
  const runningSha = process.env.SPECTRE_BUILD_SHA?.trim() || null;

  const token = getGithubToken();
  if (!token) {
    return {
      runningSha,
      latestSha: null,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: "No GitHub token configured (Settings) — cannot check the private repo.",
    };
  }

  let latestSha: string | null = null;
  try {
    latestSha = await fetchLatestSha(token);
  } catch (err) {
    return {
      runningSha,
      latestSha: null,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: `GitHub check failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (!latestSha) {
    return { runningSha, latestSha: null, behind: null, updateAvailable: false, checkedAt, note: "GitHub returned no commit SHA." };
  }
  if (!runningSha) {
    return {
      runningSha,
      latestSha,
      behind: null,
      updateAvailable: false,
      checkedAt,
      note: "Running SHA unknown (image built without SPECTRE_BUILD_SHA) — rebuild via scripts/spectre-update.sh to enable detection.",
    };
  }

  const behind = !sameCommit(runningSha, latestSha);
  return { runningSha, latestSha, behind, updateAvailable: behind, checkedAt };
}

export const update = new Hono();

update.get("/status", async (c) => c.json(await checkUpdateStatus()));

// ── Reminder settings (Settings → Updates; also the banner's Mute action).
//    Per target (core vs shell), chosen independently.
update.get("/reminders", (c) => c.json(getUpdateReminders()));

update.put("/reminders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    target?: unknown;
    mode?: unknown;
    muteForMs?: unknown;
  };
  if (body.target !== "core" && body.target !== "shell") {
    return c.json({ error: 'target must be "core" or "shell"' }, 400);
  }
  const target = body.target as UpdateTarget;
  const patch: Partial<TargetReminders> = {};
  if (body.mode !== undefined) {
    if (body.mode !== "ask" && body.mode !== "auto" && body.mode !== "off") {
      return c.json({ error: 'mode must be "ask", "auto" or "off"' }, 400);
    }
    patch.mode = body.mode as UpdateReminderMode;
  }
  if (body.muteForMs !== undefined) {
    const ms = Number(body.muteForMs);
    if (!Number.isFinite(ms) || ms < 0) {
      return c.json({ error: "muteForMs must be a non-negative number of milliseconds" }, 400);
    }
    patch.mutedUntil = Date.now() + ms;
  }
  return c.json(await setUpdateReminders(target, patch));
});

// ── One-click apply → the updater sidecar (opt-in `update` compose profile).
//    A container can't rebuild itself, so the privileged updater sidecar (host
//    Docker socket) drives the update script. The Shell hits these; if the sidecar
//    isn't enabled, /apply 503s with guidance and the UI falls back to the command.
const UPDATER_URL = (process.env.UPDATER_URL || "http://updater:8020").replace(/\/+$/, "");
const UPDATER_TOKEN = process.env.UPDATER_TOKEN || "";

function updaterFetch(path: string, init?: RequestInit) {
  return fetch(`${UPDATER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-updater-token": UPDATER_TOKEN,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

update.post("/apply", async (c) => {
  if (!UPDATER_TOKEN) {
    return c.json(
      { error: "The one-click updater isn't enabled — start the stack with the `update` compose profile." },
      503,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { target?: unknown };
  const target = typeof body.target === "string" ? body.target : "both";
  if (!["both", "core", "shell"].includes(target)) {
    return c.json({ error: "target must be both, core or shell" }, 400);
  }
  try {
    const r = await updaterFetch("/apply", { method: "POST", body: JSON.stringify({ target }) });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch (err) {
    return c.json({ error: `updater unreachable: ${err instanceof Error ? err.message : err}` }, 502);
  }
});

// The Shell polls this while an update runs (state + a tail of the log).
update.get("/apply/status", async (c) => {
  if (!UPDATER_TOKEN) return c.json({ enabled: false, state: "unavailable" });
  try {
    const r = await updaterFetch("/status");
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({ enabled: true, ...data });
  } catch (err) {
    return c.json({ enabled: true, state: "unknown", error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Background check: every 6h, report (once per new remote SHA) when an
//    update is available. Started from main.ts; guarded + fail-soft.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000; // let the token hydrate from app_config first
let loopStarted = false;
let lastReportedSha: string | null = null;

// Local model for the reminder chat: keeps the notification free (no API spend)
// and self-contained. A seeded Ollama entry (lib/ai/models.ts) served through
// the litellm gateway.
const REMINDER_MODEL = "qwen2.5:7b-instruct";
const REMINDER_TIMEOUT_MS = 30_000;

// Per-target instruction lines. `mode` is the ACTIVE target's chosen mode.
// Targets that are off/muted are omitted by the caller (never passed here).
function coreLine(mode: UpdateReminderMode): string {
  return mode === "auto"
    ? "- Core: will auto-update (recommended) — the host `--auto` runner applies it if you set up the cron; otherwise run `scripts/spectre-update.sh --apply --target core`."
    : "- Core: run `scripts/spectre-update.sh --apply --target core` on the host to apply it.";
}
const SHELL_WARNING =
  "this overwrites the shell's committed files, but does NOT touch your modules — separate-repo modules (e.g. spectre-lingua), /data extensions (skills/tools/mcp), or uncommitted local changes (the updater refuses to run on a dirty tree).";
function shellLine(mode: UpdateReminderMode): string {
  return mode === "auto"
    ? `- Shell: will auto-update — the host \`--auto\` runner applies it if you set up the cron; otherwise run \`scripts/spectre-update.sh --apply --target shell\`. Note: ${SHELL_WARNING}`
    : `- Shell: run \`scripts/spectre-update.sh --apply --target shell\` on the host. Note: ${SHELL_WARNING}`;
}

/** The per-target instruction lines for the active targets, in order. */
function activeTargetLines(active: { target: UpdateTarget; mode: UpdateReminderMode }[]): string[] {
  return active.map((a) => (a.target === "core" ? coreLine(a.mode) : shellLine(a.mode)));
}

/** Deterministic reminder text — also the fallback when the model call fails. */
function staticReminderMessage(
  running: string,
  latest: string,
  active: { target: UpdateTarget; mode: UpdateReminderMode }[],
): string {
  return (
    `A new version of Spectre is available (running ${running} → latest ${latest}). Here's what to do per part:\n\n` +
    activeTargetLines(active).join("\n") +
    `\n\nYou can also mute reminders, or change each part's mode (Ask / Auto / Off) in Settings → Updates.`
  );
}

/** Short friendly opening line from a local model via the litellm gateway. */
async function generateReminderMessage(
  running: string,
  latest: string,
  active: { target: UpdateTarget; mode: UpdateReminderMode }[],
): Promise<string | null> {
  const base = process.env.SPECTRE_LITELLM_URL;
  if (!base) return null;
  const prompt =
    `A new version of Spectre is available (running ${running} → latest ${latest}). Spectre has two parts ` +
    `updated independently. In 2-4 sentences, tell the user and ask if they want to update, then relay ONLY ` +
    `these per-part instructions faithfully (keep the code commands and the shell warning intact):\n` +
    activeTargetLines(active).join("\n") +
    `\nAlso mention they can mute reminders or change each part's mode (Ask / Auto / Off) in Settings → Updates.`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SPECTRE_LITELLM_KEY || "sk-spectre-local"}`,
    },
    body: JSON.stringify({
      model: REMINDER_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(REMINDER_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = body.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/**
 * Open a conversational reminder: one `threads` row (tagged metadata.kind
 * "update") + one assistant message, generated by a local model with a static
 * fallback so the chat appears even when the gateway is down. Called once per
 * new remote SHA (the lastReportedSha guard in backgroundCheck), only for the
 * targets whose reminders are active. Fail-soft.
 */
async function createUpdateReminderChat(
  runningSha: string | null,
  latestSha: string,
  active: { target: UpdateTarget; mode: UpdateReminderMode }[],
): Promise<void> {
  const supabase = createServiceSupabase();
  const { data: thread, error } = await supabase
    .from("threads")
    .insert({
      title: "Spectre update available",
      model_hint: REMINDER_MODEL,
      metadata: {
        kind: "update",
        latest_sha: latestSha,
        running_sha: runningSha,
        targets: active.map((a) => a.target),
      },
    })
    .select("id")
    .single();
  if (error || !thread?.id) return;

  const running = runningSha ? runningSha.slice(0, 7) : "unknown";
  const latest = latestSha.slice(0, 7);

  let content: string | null = null;
  try {
    content = await generateReminderMessage(running, latest, active);
  } catch {
    content = null; // fall back to the static message below
  }
  if (!content) content = staticReminderMessage(running, latest, active);

  await supabase
    .from("messages")
    .insert({ thread_id: thread.id, role: "assistant", content, status: "done" });
}

async function backgroundCheck(): Promise<void> {
  try {
    const status = await checkUpdateStatus();
    if (!status.updateAvailable || !status.latestSha) return;
    if (lastReportedSha && sameCommit(lastReportedSha, status.latestSha)) return; // already reported this commit
    // Reminder fires only for targets that are active (not off, not muted).
    const now = Date.now();
    const reminders = getUpdateReminders();
    const active = (["core", "shell"] as const)
      .filter((t) => remindersActive(t, now))
      .map((t) => ({ target: t as UpdateTarget, mode: reminders[t].mode }));
    // No active target: stay quiet AND leave lastReportedSha unset, so the
    // reminder for this commit still fires once a mute expires / a target flips on.
    if (active.length === 0) return;
    lastReportedSha = status.latestSha;
    await reportEvent({
      severity: "info",
      component: "update",
      description:
        `Spectre update available (${status.runningSha?.slice(0, 12)} → ${status.latestSha.slice(0, 12)}) — ` +
        `run scripts/spectre-update.sh --apply on the host (targets: ${active.map((a) => a.target).join(", ")}).`,
      push: false,
    });
    await createUpdateReminderChat(status.runningSha, status.latestSha, active);
  } catch {
    /* fail-soft: a broken update check must never hurt the core */
  }
}

/** Idempotent — safe to call more than once; only the first call arms the timers. */
export function startUpdateCheckLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  setTimeout(() => void backgroundCheck(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void backgroundCheck(), CHECK_INTERVAL_MS);
}
