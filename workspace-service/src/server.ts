/**
 * workspace-service — standalone Node + Hono HTTP server.
 *
 * Hosts the dual-mode Workspace backend (sandbox slots + trusted folders) that
 * the Spectre-monolith used to expose under /api/workspace/*. Designed to run in
 * its own Docker container ("workspace-service") for the Spectre product and to
 * be reached ONLY through the Spectre core/shell, which injects the
 * x-workspace-token header when proxying.
 *
 * Routing:
 *   GET  /health          — liveness probe, NO auth.
 *   /workspace/*          — all guarded by the x-workspace-token middleware.
 *
 * Env:
 *   WORKSPACE_SERVICE_TOKEN  required; fail-closed (503) if unset.
 *   WORKSPACE_ROOT           sandbox slot root (default /workspaces).
 *   WORKSPACE_TRUSTED_DIRS   csv of absolute bind-mounted trusted folders.
 *   GH_TOKEN                 injected by safe-spawn into git/gh; never client.
 *   PORT                     listen port (default 8010).
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { workspaceAuth } from "./auth.js";
import { workspace, listHandler } from "./routes.js";

const app = new Hono();

// Health check — intentionally BEFORE the auth gate so probes don't need a token.
app.get("/health", (c) => c.json({ ok: true }));

// Everything under /workspace requires the shared token (constant-time, fail-closed).
app.use("/workspace", workspaceAuth);
app.use("/workspace/*", workspaceAuth);

// Mount the dual-mode workspace routes under the /workspace base path.
app.route("/workspace", workspace);

// Hono maps a mounted sub-app's "/" only to /workspace (no trailing slash), so
// /workspace/ would 404. Bind the list handler to the trailing-slash form too
// (already covered by the /workspace/* auth above) so both shapes work without
// a method-dropping 301 redirect.
app.get("/workspace/", listHandler);

const port = Number.parseInt(process.env.PORT ?? "8010", 10);
const host = "0.0.0.0";

serve({ fetch: app.fetch, port, hostname: host }, (_info) => {
  // eslint-disable-next-line no-console
});

export { app };
