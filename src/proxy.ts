import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/session-token";

/**
 * Shell edge auth. The shell serves the UI and proxies /api/* to the private
 * core; this gate is the PIN/session boundary for browser traffic. The core
 * itself is loopback-only and authenticated separately by CORE_TOKEN (injected
 * in the catch-all proxy), so this only protects the user-facing surface.
 */

const PUBLIC_PATHS = [
  "/pin",
  "/api/auth/pin",
  // Code-mode sandbox docs/runtime + bundles. The opaque frame fetches these
  // cookie-less (allow-scripts only → null origin), so the session gate would
  // bounce them to /pin. They carry NO sensitive data; the locked CSP (see
  // next.config headers) is what secures them, not auth.
  "/sandbox",
  // Channel webhooks: external services (Telegram, …) POST here with NO session
  // cookie, so the PIN gate would bounce them. Each webhook authenticates to the
  // core by its own per-bot secret (verified in src/server/routes/channels.ts);
  // the catch-all proxy still injects CORE_TOKEN. Default-deny sender allowlist.
  "/api/channels",
  // GitHub webhook: GitHub POSTs with NO session cookie. The route is
  // self-authenticating — HMAC-SHA256 over the raw body against
  // GITHUB_WEBHOOK_SECRET, fail-closed when the secret is unset (see
  // src/server/routes/github.ts in the core).
  "/api/github/webhook",
  // PWA install surface — the browser fetches these BEFORE the PIN to show the
  // "Add to Home Screen" prompt and the home-screen icon. They carry no data.
  "/manifest.webmanifest",
  "/sw.js",
  "/icon",
  "/apple-icon",
  "/icons",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json"
  ) {
    return NextResponse.next();
  }

  // Verify the cookie is a VALID HMAC-signed session token, not merely present —
  // a bare/forged cookie no longer passes. verifySession() uses Web Crypto so it
  // runs in both the Edge and Node middleware runtimes.
  const token = request.cookies.get("spectre_session")?.value;
  const ok = await verifySession(token, process.env.SESSION_SECRET ?? "");
  if (!ok) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/pin", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
