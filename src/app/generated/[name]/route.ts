import { NextRequest } from "next/server";

/**
 * Serve generated images (openai.image output, screenshots) to the browser by
 * streaming them from the private core's top-level /generated/<name> byte route.
 * The /api/[...path] catch-all only forwards /api/*, so /generated needs its own
 * proxy. Session-gated by the shell middleware (not a PUBLIC_PATH), so only a
 * logged-in browser can fetch them.
 */
const CORE_URL = process.env.CORE_URL || "http://127.0.0.1:8787";
const CORE_TOKEN = process.env.CORE_TOKEN || "";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const res = await fetch(`${CORE_URL}/generated/${encodeURIComponent(name)}`, {
    headers: { "x-spectre-core-token": CORE_TOKEN },
  });
  const headers = new Headers();
  const ct = res.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cc = res.headers.get("cache-control");
  if (cc) headers.set("cache-control", cc);
  return new Response(res.body, { status: res.status, headers });
}
