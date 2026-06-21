/**
 * The debugging engine. Everything that goes wrong anywhere in the core funnels
 * through reportEvent() into monitor_events, so (a) the core has a single record
 * of what's failing, (b) Jerome can see recent issues (injected into his prompt
 * + queryable) and proactively flag them, and (c) criticals push to the user.
 *
 * Best-effort by contract: reporting a failure must never throw or mask the
 * original error. Reuses the existing monitor_events table (no migration):
 *   severity   -> info | warning | critical
 *   component  -> the source ("chat-run", "chat-runner", "provider:claude-code", …)
 *   description-> the human message
 *   analysis   -> { detail, threadId } structured context
 */

import { createServiceSupabase } from "@/lib/supabase/server";

export type Severity = "info" | "warning" | "critical";

export interface ReportInput {
  severity: Severity;
  component: string;
  description: string;
  detail?: unknown;
  threadId?: string;
  /** Push a notification to the user (only honored for critical). */
  push?: boolean;
}

export async function reportEvent(e: ReportInput): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    await supabase.from("monitor_events").insert({
      severity: e.severity,
      component: e.component.slice(0, 120),
      description: e.description.slice(0, 1000),
      analysis: { detail: serialize(e.detail), threadId: e.threadId ?? null },
    });

    if (e.push && e.severity === "critical") {
      try {
        const { sendPush } = await import("@/lib/notify");
        await sendPush({
          title: "Jerome hit a snag",
          body: `${e.component}: ${e.description}`.slice(0, 160),
          url: e.threadId ? `/chat/${e.threadId}` : "/",
        });
      } catch {
        /* push is best-effort (no VAPID / no subscription is fine) */
      }
    }
  } catch (err) {
    // Last resort: never let the debugging engine crash the caller.
    console.error(`[reportEvent] failed to record "${e.component}": ${err instanceof Error ? err.message : err}`);
  }
}

function serialize(detail: unknown): unknown {
  if (detail instanceof Error) return { message: detail.message, stack: detail.stack };
  return detail ?? null;
}

export interface Issue {
  severity: string;
  component: string;
  description: string;
  created_at: string;
}

/** Recent warning/critical events — for surfacing to Jerome. */
export async function recentIssues(minutes = 15, limit = 4): Promise<Issue[]> {
  try {
    const supabase = createServiceSupabase();
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const { data } = await supabase
      .from("monitor_events")
      .select("severity, component, description, created_at")
      .in("severity", ["warning", "critical"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []) as Issue[];
  } catch {
    return [];
  }
}

/**
 * Proactive system health sweep — run on a schedule so the debugging engine
 * catches degradation (no AI providers, Supabase unreachable) on its own, not
 * just when a chat happens to fail. Each problem found is reported (critical
 * ones push). Returns a small summary for the run record.
 */
export async function runHealthSweep(): Promise<{ providers: string[]; problems: number }> {
  let problems = 0;

  // AI providers — if none, chat is dead.
  let providers: string[] = [];
  try {
    const { detectProviders, getAvailableProviders } = await import("@/lib/ai/providers");
    await detectProviders();
    providers = getAvailableProviders();
    if (providers.length === 0) {
      problems++;
      await reportEvent({
        severity: "critical",
        component: "health:providers",
        description: "No AI providers available — chat will fail until one is restored.",
        push: true,
      });
    }
  } catch (err) {
    problems++;
    await reportEvent({ severity: "critical", component: "health:providers", description: `Provider detection failed: ${err instanceof Error ? err.message : err}` });
  }

  // Storage round-trip.
  try {
    const supabase = createServiceSupabase();
    const { error } = await supabase.from("app_config").select("key").limit(1);
    if (error) {
      problems++;
      await reportEvent({ severity: "critical", component: "health:supabase", description: `Supabase unreachable: ${error.message}`, push: true });
    }
  } catch (err) {
    problems++;
    await reportEvent({ severity: "critical", component: "health:supabase", description: `Supabase check threw: ${err instanceof Error ? err.message : err}` });
  }

  return { providers, problems };
}

/** A compact system-prompt block so Jerome is aware of recent failures and can
 *  proactively (and briefly) flag them. Empty string when all is well. */
export function buildIssuesBlock(issues: Issue[]): string {
  if (issues.length === 0) return "";
  const lines = issues.map((i) => `- [${i.severity}] ${i.component}: ${i.description}`).join("\n");
  return (
    `\n\n## Recent system issues\n` +
    `Problems your own systems logged in the last few minutes. If relevant to ` +
    `what the user is doing, proactively but briefly flag them — don't belabor it.\n${lines}\n`
  );
}
