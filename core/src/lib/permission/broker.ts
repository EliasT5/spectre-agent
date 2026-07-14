/**
 * Permission broker — the Node-side state for Jerome's MCP approval flow.
 *
 * spectre-mcp-broker (a separate process spawned by the Claude CLI) POSTs
 * every gated tool call to `/api/threads/[threadId]/permission/request`.
 * That route calls `enqueue()` here to (a) persist a pending entry keyed by
 * a fresh reqId and (b) surface the request to any listeners (the SSE
 * stream writer picks it up and forwards to the browser as a
 * `permission_request` event).
 *
 * The UI then POSTs the human's decision to
 * `/api/threads/[threadId]/permission/[reqId]`, which calls `resolve()` to
 * unblock the pending request — the MCP broker's HTTP call returns, and
 * Claude either sees the tool result or a "denied by user" error.
 *
 * State is module-level, so it lives for the lifetime of the Next.js
 * server process. A jerome-app restart cancels all in-flight approvals
 * (they'll time out broker-side after ~2 min).
 */

import { createServiceSupabase } from "@/lib/supabase/server";
import { safeEqual } from "@/lib/auth/ct";
import { getDangerSettings } from "@/lib/danger-settings";

export type PermissionDecision = "allow" | "deny" | "allow_session";

export interface PermissionResolution {
  decision: PermissionDecision;
  reason?: string;
  answer?: unknown;
}

// ---------------------------------------------------------------------------
// Persistence layer (P1.2): policy lookup, hourly quotas, and a call log.
//
// These tables (supabase/tool_policies.sql) let a decision PERSIST so the
// broker can auto-resolve without re-prompting, and bound autonomous tool use
// with optional per-tool hourly quotas. Every DB access here is wrapped so a
// transient Supabase hiccup NEVER blocks or corrupts the in-memory approval
// flow: on any error we fall back to the normal human-prompt path. We never
// auto-allow on error.
// ---------------------------------------------------------------------------

type ServiceSupabase = ReturnType<typeof createServiceSupabase>;
let _supabase: ServiceSupabase | null = null;

/** Lazy, cached service client. Returns null if construction throws. */
function db(): ServiceSupabase | null {
  if (_supabase) return _supabase;
  try {
    _supabase = createServiceSupabase();
    return _supabase;
  } catch {
    return null;
  }
}

type PolicyDecision = "always_allow" | "always_deny";

interface PolicyRow {
  scope: "global" | "thread" | "module";
  scope_id: string | null;
  decision: PolicyDecision;
  quota_per_hour: number | null;
}

/** Sentinel returned by lookupPolicy when the DB itself errored (vs no matching policy). */
const DB_ERROR = Symbol("DB_ERROR");
type DbError = typeof DB_ERROR;

/**
 * Resolve the effective policy for a tool in a thread. Selects all live
 * (non-expired) global + thread-scoped rows for the tool; thread scope wins
 * over global.
 *
 * Returns:
 *   - a policy object  → a matching policy was found
 *   - null             → DB is healthy but no policy applies (fall through to human prompt)
 *   - DB_ERROR symbol  → the DB itself errored; the caller MUST treat this as a
 *                        denial on autonomous runs (fail-closed) and fall through
 *                        to the human-prompt path on interactive runs.
 *
 * The returned `scope`/`scopeId` tell the caller HOW to count the quota: a
 * THREAD-scoped policy's quota must be measured against that thread's calls
 * only, not every call of the tool system-wide (see recentCallCount).
 */
async function lookupPolicy(
  tool: string,
  threadId: string
): Promise<{
  decision: PolicyDecision;
  quota_per_hour: number | null;
  scope: "global" | "thread" | "module";
  scopeId: string | null;
} | null | DbError> {
  const supabase = db();
  if (!supabase) return DB_ERROR;
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("tool_policies")
      .select("scope, decision, quota_per_hour, scope_id, expires_at")
      .eq("tool", tool)
      .or(`scope.eq.global,and(scope.eq.thread,scope_id.eq.${threadId})`)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

    if (error || !data) return DB_ERROR;

    const rows = data as PolicyRow[];
    if (rows.length === 0) return null;

    const threadRow = rows.find((r) => r.scope === "thread");
    const chosen = threadRow ?? rows.find((r) => r.scope === "global");
    if (!chosen) return null;

    return {
      decision: chosen.decision,
      quota_per_hour: chosen.quota_per_hour,
      scope: chosen.scope,
      scopeId: chosen.scope_id,
    };
  } catch {
    return DB_ERROR;
  }
}

/**
 * Count resolved tool_calls for a tool in the trailing hour (quota source).
 *
 * When `threadId` is supplied (the matched policy is THREAD-scoped), the count
 * is restricted to that thread's auto-resolved calls, so a thread-scoped quota
 * (e.g. proactive notify=3/hr) is measured against THAT thread's autonomous use
 * only — not every call of the tool system-wide (normal chat, scheduler notify
 * jobs, etc.). When `threadId` is omitted (global policy), the count stays
 * global, matching a global quota's intent.
 *
 * Returns:
 *   - a number  → DB is healthy; this is the real call count (may be 0)
 *   - null      → DB errored; callers on the autonomous path MUST treat this as
 *                 quota-exceeded (fail-closed). Interactive callers may treat it
 *                 as 0 to keep the human-prompt path unblocked.
 */
async function recentCallCount(tool: string, threadId?: string): Promise<number | null> {
  const supabase = db();
  if (!supabase) return null;
  try {
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let query = supabase
      .from("tool_calls")
      .select("id", { count: "exact", head: true })
      .eq("tool", tool)
      .gte("created_at", sinceIso);
    if (threadId) {
      // Thread-scoped quota: count only this thread's policy-driven calls.
      query = query.eq("thread_id", threadId).eq("auto", true);
    }
    const { count, error } = await query;
    if (error || count == null) return null;
    return count;
  } catch {
    return null;
  }
}

/** Fire-and-forget audit/quota log. Swallows all errors. */
function logCall(
  tool: string,
  threadId: string,
  decision: "allow" | "deny",
  auto: boolean
): void {
  const supabase = db();
  if (!supabase) return;
  void (async () => {
    try {
      await supabase
        .from("tool_calls")
        .insert({ tool, thread_id: threadId, decision, auto });
    } catch {
      /* swallow — logging must never affect the approval flow */
    }
  })();
}

/**
 * Upsert a live policy for (tool, scope, scope_id). `allow_session` uses this
 * with a TTL so the decision survives a core restart but still expires; the
 * P1.1 bounded proactive run uses it to PRE-SEED short-lived `always_allow`
 * thread policies (with an optional per-tool hourly quota) so its whitelisted
 * tool calls auto-resolve without a human prompt no one would answer.
 *
 * We do a select-then-update/insert rather than relying on onConflict because
 * the unique index is on coalesce(scope_id, ''), an expression PostgREST can't
 * target by column list.
 *
 * Best-effort BUT observable: by default errors are swallowed (the
 * allow_session caller must never have its approval flow blocked). Pass
 * `throwOnError: true` — as the proactive pre-seeder does — to surface a DB
 * failure so the caller can DEGRADE GRACEFULLY to proposal-only instead of
 * spawning a tool-enabled run whose tool calls would then hang on a prompt.
 */
async function persistPolicy(opts: {
  tool: string;
  scope: "global" | "thread" | "module";
  scopeId?: string | null;
  decision: PolicyDecision;
  ttlMs?: number;
  /** null/undefined = unlimited; otherwise the per-tool trailing-hour cap. */
  quotaPerHour?: number | null;
  /** When true, rethrow DB errors instead of swallowing them. */
  throwOnError?: boolean;
}): Promise<void> {
  const supabase = db();
  if (!supabase) {
    if (opts.throwOnError) throw new Error("persistPolicy: no Supabase client");
    return;
  }
  const scopeId = opts.scopeId ?? null;
  const expiresAt =
    opts.ttlMs != null ? new Date(Date.now() + opts.ttlMs).toISOString() : null;
  const quota = opts.quotaPerHour ?? null;
  try {
    let query = supabase
      .from("tool_policies")
      .select("id")
      .eq("tool", opts.tool)
      .eq("scope", opts.scope);
    query = scopeId === null ? query.is("scope_id", null) : query.eq("scope_id", scopeId);
    const { data: existing, error: selErr } = await query.maybeSingle();
    if (selErr) {
      if (opts.throwOnError) throw selErr;
      return;
    }

    if (existing && (existing as { id: string }).id) {
      const { error: updErr } = await supabase
        .from("tool_policies")
        .update({ decision: opts.decision, expires_at: expiresAt, quota_per_hour: quota })
        .eq("id", (existing as { id: string }).id);
      if (updErr && opts.throwOnError) throw updErr;
    } else {
      const { error: insErr } = await supabase.from("tool_policies").insert({
        tool: opts.tool,
        scope: opts.scope,
        scope_id: scopeId,
        decision: opts.decision,
        expires_at: expiresAt,
        quota_per_hour: quota,
      });
      if (insErr && opts.throwOnError) throw insErr;
    }
  } catch (err) {
    if (opts.throwOnError) throw err;
    /* swallow — persistence is best-effort, never blocks approval */
  }
}

/**
 * Irreversible/destructive tools that must NOT be blanket-authorized by a single
 * "Allow for session" click. For these, allow_session still permits the CURRENT
 * call, but no 12h always-allow policy is persisted — so every invocation
 * re-prompts. Without this, one approval on e.g. chats.distill (distill a chat to
 * memory, then permanently delete it) would let the agent loop and wipe the whole
 * chat history unprompted. Keyed by the tool name the broker enqueues (dot form).
 */
const NO_SESSION_ALLOW = new Set<string>(["chats.distill"]);

/**
 * Exported pre-seeder for the P1.1 bounded proactive run. Wrapper around
 * persistPolicy with throwOnError set so the proactive runner can detect a
 * missing/unmigrated tool_policies table and fall back to proposal-only.
 */
export async function persistProactivePolicy(opts: {
  tool: string;
  scopeId: string;
  ttlMs?: number;
  quotaPerHour?: number | null;
}): Promise<void> {
  await persistPolicy({
    tool: opts.tool,
    scope: "thread",
    scopeId: opts.scopeId,
    decision: "always_allow",
    ttlMs: opts.ttlMs,
    quotaPerHour: opts.quotaPerHour,
    throwOnError: true,
  });
}

export interface PendingApproval {
  reqId: string;
  threadId: string;
  tool: string;
  input: unknown;
  createdAt: number;
  resolve: (decision: PermissionResolution) => void;
}

const pending = new Map<string, PendingApproval>();
const byThread = new Map<string, Set<string>>();

// SSE streams register a notifier so the messages route can forward
// permission_request events to the browser as they land.
type Notifier = (p: PendingApproval) => void;
const notifiers = new Map<string, Set<Notifier>>();

export function listPending(): Array<{
  reqId: string;
  threadId: string;
  tool: string;
  input: unknown;
  createdAt: number;
}> {
  return Array.from(pending.values()).map((p) => ({
    reqId: p.reqId,
    threadId: p.threadId,
    tool: p.tool,
    // The approver needs to see WHAT they're approving (e.g. the bash command).
    input: p.input,
    createdAt: p.createdAt,
  }));
}

/**
 * Danger Zone: does this tool call read or touch a `.env*` secrets file? Covers
 * the agent's file tools — bash (the command references .env), write/edit (the
 * file_path is a .env file). Matches `.env`, `.env.docker`, `.env.local`, etc.
 */
function touchesEnvFile(tool: string, input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  const isEnvPath = (p: unknown) =>
    typeof p === "string" && /(^|[\\/])\.env(\.[\w.-]+)?$/.test(p.trim());
  if (tool === "write" || tool === "edit") return isEnvPath(o.file_path);
  if (tool === "bash") {
    return typeof o.command === "string" &&
      /(?:^|[\s"'`=<>|&;:()/\\])\.env(?:\.[\w.-]+)?\b/.test(o.command);
  }
  return false;
}

export async function enqueue(
  threadId: string,
  tool: string,
  input: unknown,
  autonomous = false,
  /**
   * Optional AbortSignal from the HTTP request that started this approval
   * (i.e. c.req.raw.signal in the /permission/request handler). When the
   * broker process dies or resets the connection, the request is aborted and
   * this signal fires — we immediately deny and clean up the slot rather than
   * letting it sit until SPECTRE_APPROVAL_TIMEOUT_MS.
   */
  abortSignal?: AbortSignal
): Promise<PermissionResolution> {
  // 0. Danger Zone: block reading/touching .env secrets files unless the operator
  //    enabled it in Settings → Danger Zone. Runs before any policy/auto-allow, so
  //    an always_allow policy (or an autonomous run) can never bypass it.
  if (!getDangerSettings().allowEnvAccess && touchesEnvFile(tool, input)) {
    logCall(tool, threadId, "deny", autonomous);
    return { decision: "deny", reason: ".env access is off — enable it in Settings → Danger Zone" };
  }

  // 1. Consult any persistent policy before troubling a human.
  //
  //    lookupPolicy returns one of three values:
  //      DB_ERROR symbol -> the DB itself errored (network down, schema missing, etc.)
  //      null            -> DB is healthy but no policy row matches this tool/thread
  //      policy object   -> a live policy was found; apply its decision + quota
  //
  //    Fail-closed rule: on the autonomous path a DB error must DENY immediately.
  //    There is no human standing by, so falling through to the prompt would
  //    simply hang until the MCP broker timeout. Interactive runs fall through
  //    to the normal human-prompt path on DB error, leaving spend in human hands.
  const policy = await lookupPolicy(tool, threadId);

  if (policy === DB_ERROR) {
    if (autonomous) {
      logCall(tool, threadId, "deny", true);
      return { decision: "deny", reason: "db error -- autonomous run denied (fail-closed)" };
    }
    // Interactive: fall through to human-prompt path (DB_ERROR treated as no-policy)
  } else if (policy !== null) {
    if (policy.decision === "always_deny") {
      logCall(tool, threadId, "deny", true);
      return { decision: "deny", reason: "policy: always deny" };
    }
    // always_allow -- honour the optional hourly quota. Count is scoped to the
    // matched policy: a thread-scoped policy counts only THIS thread's auto
    // calls; a global policy counts the tool system-wide.
    //
    // recentCallCount returns null on DB error. Autonomous path: fail closed.
    // Interactive path: fall through to human prompt (don't silently allow).
    if (policy.quota_per_hour != null) {
      const recent = await recentCallCount(
        tool,
        policy.scope === "thread" ? threadId : undefined
      );
      if (recent === null) {
        // DB error reading the quota counter.
        if (autonomous) {
          logCall(tool, threadId, "deny", true);
          return { decision: "deny", reason: "db error -- quota unreadable, autonomous run denied (fail-closed)" };
        }
        // Interactive: fall through to human-prompt path
      } else if (recent >= policy.quota_per_hour) {
        logCall(tool, threadId, "deny", true);
        return { decision: "deny", reason: "quota exceeded" };
      } else {
        logCall(tool, threadId, "allow", true);
        return { decision: "allow", reason: "policy: always allow" };
      }
    } else {
      logCall(tool, threadId, "allow", true);
      return { decision: "allow", reason: "policy: always allow" };
    }
  }

  // 2. No policy (or DB error on interactive run) -- the existing human-prompt
  //    flow, unchanged except that the resolve handler is wrapped to log the
  //    outcome and, for allow_session, persist a TTL'd thread policy. The
  //    broker still receives the original resolution unchanged (incl. allow_session).
  const reqId = crypto.randomUUID();
  return new Promise<PermissionResolution>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wrappedResolve = (res: PermissionResolution) => {
      if (settled) return; // a human decision and the timeout can't both fire
      settled = true;
      if (timer) clearTimeout(timer);
      logCall(tool, threadId, res.decision === "deny" ? "deny" : "allow", false);
      if (res.decision === "allow_session" && !NO_SESSION_ALLOW.has(tool)) {
        void persistPolicy({
          tool,
          scope: "thread",
          scopeId: threadId,
          decision: "always_allow",
          ttlMs: 12 * 60 * 60 * 1000,
        });
      }
      resolve(res);
    };

    const entry: PendingApproval = {
      reqId,
      threadId,
      tool,
      input,
      createdAt: Date.now(),
      resolve: wrappedResolve,
    };
    pending.set(reqId, entry);
    let threadSet = byThread.get(threadId);
    if (!threadSet) {
      threadSet = new Set();
      byThread.set(threadId, threadSet);
    }
    threadSet.add(reqId);

    // Fast-deny when the broker's HTTP connection drops (process died / ECONNRESET).
    // The AbortSignal fires the moment the request is aborted, so we resolve the
    // pending immediately as a deny and clean up the slot — no waiting for the
    // full SPECTRE_APPROVAL_TIMEOUT_MS window.
    if (abortSignal) {
      const onAbort = () => {
        pending.delete(reqId);
        byThread.get(threadId)?.delete(reqId);
        wrappedResolve({ decision: "deny", reason: "broker connection dropped — fast-deny" });
      };
      if (abortSignal.aborted) {
        // Already aborted before we even registered — deny immediately.
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const threadNotifiers = notifiers.get(threadId);
    if (threadNotifiers) {
      for (const n of threadNotifiers) n(entry);
    }

    // FAIL-CLOSED bounded wait. Until the approve/deny UI is wired, no human can
    // respond, so an un-policied gated tool would otherwise block the whole turn
    // until the MCP client's ~30-min ceiling. Deny after a bounded window instead.
    // With the UI present a human responds in seconds; raise the window if needed.
    // 0 disables (infinite wait). Persistent `tool_policies` (always_allow) still
    // auto-resolve above and bypass this entirely.
    const timeoutMs = Number(process.env.SPECTRE_APPROVAL_TIMEOUT_MS ?? 180_000);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pending.delete(reqId);
        byThread.get(threadId)?.delete(reqId);
        wrappedResolve({ decision: "deny", reason: "approval timed out — no decision (fail-closed)" });
      }, timeoutMs);
    }
  });
}

export function resolvePermission(
  reqId: string,
  decision: PermissionDecision,
  reason?: string,
  answer?: unknown
): boolean {
  const entry = pending.get(reqId);
  if (!entry) return false;
  pending.delete(reqId);
  byThread.get(entry.threadId)?.delete(reqId);
  entry.resolve({ decision, reason, answer });
  return true;
}

export function registerNotifier(threadId: string, fn: Notifier): () => void {
  let set = notifiers.get(threadId);
  if (!set) {
    set = new Set();
    notifiers.set(threadId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) notifiers.delete(threadId);
  };
}

export function cancelThread(threadId: string): number {
  const set = byThread.get(threadId);
  if (!set) return 0;
  let count = 0;
  for (const reqId of set) {
    const entry = pending.get(reqId);
    if (!entry) continue;
    pending.delete(reqId);
    entry.resolve({ decision: "deny", reason: "thread aborted" });
    count++;
  }
  byThread.delete(threadId);
  return count;
}

/**
 * Check whether the service-broker auth token matches. The broker process
 * shares the same environment (.env.docker) so both sides see the same token.
 */
export function verifyBrokerToken(headerValue: string | null): boolean {
  const expected = process.env.SPECTRE_SERVICE_TOKEN;
  // FAIL CLOSED: an unconfigured service token must NEVER grant access. (Earlier
  // this returned true "for local-dev friendliness" — a fail-open hole: a prod
  // boot that forgot SPECTRE_SERVICE_TOKEN authenticated every in-box caller to
  // the dispatch / schedule-claim / permission-approval endpoints. Local dev
  // should set the token like prod.) Compared in constant time.
  if (!expected) return false;
  return safeEqual(headerValue, expected);
}
