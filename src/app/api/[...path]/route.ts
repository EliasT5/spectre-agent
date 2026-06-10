import { NextRequest } from "next/server";

/**
 * The contract boundary: every /api/* call (except the shell's own /api/auth/*)
 * is forwarded verbatim to the private core on its fixed loopback port, with the
 * CORE_TOKEN injected. The response body is streamed straight through untouched
 * so chat SSE (event: token …) reaches the browser live. This is the single
 * place the shell knows about the core; modules just call /api/... as normal.
 */

const CORE_URL = process.env.CORE_URL || "http://127.0.0.1:8787";
const CORE_TOKEN = process.env.CORE_TOKEN || "";

async function handle(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const target = `${CORE_URL}/api/${path.join("/")}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  headers.set("x-jerome-core-token", CORE_TOKEN);
  // Don't leak the shell's session cookie or host to the core; force an
  // un-encoded response so we can stream the body through as-is.
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
    init.duplex = "half"; // required when sending a stream body (Node fetch)
  }

  const res = await fetch(target, init);

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
