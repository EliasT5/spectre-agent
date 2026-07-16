import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getGithubToken } from "@/lib/github-token";

/**
 * Repo-aware agent proxy. The MCP broker's `workspace.*` tools hit these routes.
 *
 * Security model: we resolve the CALLING thread's bound slot from
 * `thread.metadata.slot_id` — the broker passes its own SPECTRE_THREAD_ID (as
 * x-spectre-thread-id), NEVER a tool argument, so the brain cannot target another
 * slot. We then forward to the ISOLATED workspace-service (:8010, the same one the
 * Workspaces UI + code-server use), injecting the service token + the GitHub token.
 * Every file/exec/clone op stays confined to the slot by the service's path-guard,
 * and runs in that untrusted-code sandbox — never in the core process.
 *
 * CORE_TOKEN-gated by the global mw.ts middleware like all /api/* routes.
 */

const WORKSPACE_URL = (process.env.WORKSPACE_URL || "http://workspace:8010").replace(/\/+$/, "");
const WORKSPACE_SERVICE_TOKEN = process.env.WORKSPACE_SERVICE_TOKEN || "";

export const wsagent = new Hono();

async function slotForThread(threadId: string | undefined): Promise<string | null> {
  if (!threadId) return null;
  const supabase = createServiceSupabase();
  const { data } = await supabase
    .from("threads")
    .select("metadata")
    .eq("id", threadId)
    .maybeSingle();
  const meta = (data?.metadata ?? {}) as { kind?: string; slot_id?: string };
  return meta.kind === "workspace" && meta.slot_id ? meta.slot_id : null;
}

wsagent.all("/*", async (c) => {
  if (!WORKSPACE_SERVICE_TOKEN) {
    return c.json({ error: "the workspace-service is not configured on the core" }, 503);
  }
  const slot = await slotForThread(c.req.header("x-spectre-thread-id"));
  if (!slot) {
    return c.json(
      { error: "This chat is not bound to a workspace slot — open it from the Workspaces tab." },
      400,
    );
  }

  const url = new URL(c.req.url);
  const sub = url.pathname.replace(/^\/api\/wsagent\/?/, "");
  const target = `${WORKSPACE_URL}/workspace/${encodeURIComponent(slot)}/${sub}${url.search}`;

  const headers: Record<string, string> = { "x-workspace-token": WORKSPACE_SERVICE_TOKEN };
  const gh = getGithubToken();
  if (gh) headers["x-gh-token"] = gh;
  const ct = c.req.header("content-type");
  if (ct) headers["content-type"] = ct;

  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = await c.req.text();
  }

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (err) {
    return c.json({ error: `workspace-service unreachable: ${(err as Error).message}` }, 502);
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") || "application/json" },
  });
});
