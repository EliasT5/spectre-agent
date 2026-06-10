import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Headless-server-friendly build; the shell is the only thing exposed to the
  // browser/tailnet and proxies /api/* to the private core on its loopback port.
  output: "standalone",

  // NOTE: the Code-mode sandbox CSP is NOT set here. The sandbox frame has an
  // OPAQUE origin (sandbox="allow-scripts"), so CSP 'self' cannot match the shell
  // origin and an external <script src> would be blocked. The frame document is
  // therefore served by a route handler (src/app/sandbox/host/route.ts) that sets
  // the locked CSP with a per-request nonce authorizing the host-runtime script.
  // A static header here would only double up and re-block it.

  async headers() {
    // Conservative, non-CSP security headers on every response. We deliberately
    // do NOT set a global Content-Security-Policy: the app is WebGL/inline-style
    // heavy and the Code-mode sandbox serves its own per-request CSP (see note
    // above) — a blanket CSP would break both. X-Frame-Options is SAMEORIGIN
    // (not DENY) so the shell can still frame its own /sandbox host document.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
