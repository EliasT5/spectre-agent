import { NextResponse } from "next/server";

/**
 * Code-mode sandbox host document — served with a PER-REQUEST nonce.
 *
 * The frame is `sandbox="allow-scripts"` → OPAQUE origin. Under an opaque origin,
 * CSP `'self'` does NOT match the shell origin, so an external
 * `<script src="/sandbox/host-runtime.js">` would be CSP-blocked (this is exactly
 * what made the module "unresponsive"). A `nonce-` source authorizes that script
 * element REGARDLESS of origin, so the frame doc must be served dynamically (a
 * static file can't carry a per-request nonce) — hence this route.
 *
 * The locked CSP otherwise stands: connect-src 'none' (no network of any kind),
 * scripts only via the nonce + blob: (the host runtime + the blob:-imported,
 * already-SRI-verified untrusted bundle), no 'unsafe-eval', no base/form/frame
 * escape. That, not auth, is what secures the frame.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const nonce = globalThis.crypto.randomUUID().replace(/-/g, "");

  const csp =
    "default-src 'none'; " +
    `script-src 'nonce-${nonce}' blob:; ` +
    "connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
    "font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>' +
    "<title>module host</title></head><body><div id=\"root\"></div>" +
    // CLASSIC script (no type="module"): a module script is fetched in CORS mode,
    // and from the frame's OPAQUE origin that needs an ACAO header the static file
    // doesn't send → it'd be blocked. A classic script fetches no-cors and runs;
    // its dynamic import() of the blob: module bundle still works.
    `<script nonce="${nonce}" src="/sandbox/host-runtime.js"></script>` +
    "</body></html>";

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
