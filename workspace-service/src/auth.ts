/**
 * Workspace-service auth middleware.
 *
 * Every request (except /health) must carry header `x-workspace-token` equal to
 * env WORKSPACE_SERVICE_TOKEN. The comparison is CONSTANT-TIME: both the
 * supplied header and the configured token are hashed with sha256, then the
 * fixed-length digests are compared via crypto.timingSafeEqual so the response
 * time never leaks how many leading bytes matched.
 *
 * FAIL CLOSED: if WORKSPACE_SERVICE_TOKEN is unset (or empty), the service has
 * no way to authenticate anyone, so EVERY guarded request is rejected with 503.
 * This prevents an unconfigured container from silently serving an open IDE.
 *
 * The Spectre core/shell injects this token server-side when it proxies; the
 * browser/client never sees or sends it directly.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

const TOKEN_HEADER = "x-workspace-token";

/** sha256 → 32-byte Buffer (fixed length, safe for timingSafeEqual). */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time equality of two strings via their sha256 digests.
 * Digests are always 32 bytes so length never short-circuits the compare.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  // Both buffers are 32 bytes; timingSafeEqual requires equal length.
  return timingSafeEqual(ha, hb);
}

/**
 * Hono middleware enforcing the x-workspace-token header.
 * Returns 503 when the service is unconfigured (no token in env),
 * 401 when the header is missing or wrong.
 */
export async function workspaceAuth(c: Context, next: Next): Promise<Response | void> {
  const expected = process.env.WORKSPACE_SERVICE_TOKEN;

  // FAIL CLOSED: no configured token → reject everything.
  if (!expected || expected.length === 0) {
    return c.json(
      {
        error:
          "workspace-service is not configured: WORKSPACE_SERVICE_TOKEN is unset. Refusing all requests.",
      },
      503,
    );
  }

  const supplied = c.req.header(TOKEN_HEADER);
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
