import { NextRequest } from "next/server";

/**
 * Workspace proxy. Unlike the rest of /api/* (which the catch-all forwards to the
 * private core), /api/workspace/* is forwarded to the opt-in `workspace-service`
 * container, injecting its x-workspace-token. This route is MORE SPECIFIC than
 * the /api/[...path] catch-all, so Next matches it first.
 *
 * The PIN gate (proxy.ts) still protects /api/workspace, so workspace access
 * always requires login. SSE bodies (shell + run-tests) stream through untouched.
 * If the service isn't running (workspace profile not enabled), fetch fails and
 * we return 503 so the UI can show "workspaces are off" rather than a hard error.
 */

const WORKSPACE_URL = process.env.WORKSPACE_URL || "http://workspace:8010";
const WORKSPACE_SERVICE_TOKEN = process.env.WORKSPACE_SERVICE_TOKEN || "";
const CORE_URL = process.env.CORE_URL || "http://127.0.0.1:8787";
const CORE_TOKEN = process.env.CORE_TOKEN || "";

/**
 * The GitHub token is set at runtime from Settings (stored in the core's
 * app_config), NOT in .env. Fetch it server-side and inject it as x-gh-token so
 * the workspace clone/push works with no file editing. The workspace-service is
 * isolated (runs untrusted repo code) and never receives core credentials — only
 * this per-request token, exactly where GH_TOKEN was headed anyway.
 */
async function currentGhToken(): Promise<string> {
  try {
    const r = await fetch(`${CORE_URL}/api/providers/github/token`, {
      headers: { "x-spectre-core-token": CORE_TOKEN },
      cache: "no-store",
    });
    if (r.ok) {
      const j = (await r.json()) as { token?: string | null };
      return typeof j?.token === "string" ? j.token : "";
    }
  } catch { /* core unreachable — fall back to the sidecar's own env, if any */ }
  return "";
}

async function handle(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${WORKSPACE_URL}/workspace/${path.join("/")}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  headers.set("x-workspace-token", WORKSPACE_SERVICE_TOKEN);
  headers.delete("x-gh-token"); // never trust a client-supplied token
  const gh = await currentGhToken();
  if (gh) headers.set("x-gh-token", gh);
  // Don't leak the shell's session cookie/host to the service; force unencoded so
  // we can stream the body (SSE) straight through.
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("accept-encoding");
  headers.delete("content-length");

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch {
    return Response.json(
      { error: "workspace-service is unavailable (enable the `workspace` compose profile)." },
      { status: 503 },
    );
  }

  const respHeaders = new Headers(res.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  return new Response(res.body, { status: res.status, headers: respHeaders });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
