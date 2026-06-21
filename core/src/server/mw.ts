import type { Context, Next } from "hono";
import { safeEqual } from "@/lib/auth/ct";

const CORE_TOKEN = process.env.CORE_TOKEN;

/**
 * CORE_TOKEN gate — ports the Next `proxy.ts` gate. Fail-closed: 503 if the token
 * is unset, 401 on mismatch. `/api/health` is the only public route. Applied
 * globally in main.ts (`app.use("/api/*", coreAuth)`) so individual handlers must
 * NOT re-check the token.
 */
export async function coreAuth(c: Context, next: Next) {
  if (c.req.path === "/api/health") return next();
  if (!CORE_TOKEN) return c.json({ error: "core not configured (no CORE_TOKEN)" }, 503);
  // Constant-time compare — CORE_TOKEN is the master capability that authenticates
  // the entire loopback brain, so a plain !== would be a byte-by-byte timing oracle.
  if (!safeEqual(c.req.header("x-spectre-core-token"), CORE_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}

/**
 * Global error boundary — logs the real error server-side but returns an OPAQUE
 * message to the caller (addresses the launch-audit "error opacity" finding:
 * raw err.message must never leak to clients).
 */
export function errorBoundary(err: Error, c: Context): Response {
  console.error("[core] unhandled route error:", err);
  return c.json({ error: "internal error" }, 500);
}
