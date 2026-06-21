/**
 * Spectre core — bun-native HTTP server (Hono). REPLACES the Next.js API layer so
 * the core compiles to a single standalone binary via `bun build --compile`.
 * The business logic (src/lib/**) is reused
 * UNCHANGED; only this HTTP layer is new. See src/server/PORTING.md.
 *
 * Run (dev):  bun run src/server/main.ts            (auto-loads .env.local)
 * Compile:    bun build --compile src/server/main.ts --outfile dist/spectre-core
 */

import { Hono } from "hono";
import { coreAuth, errorBoundary } from "./mw";
import { health } from "./routes/health";
import { models } from "./routes/models";
import { appConfig } from "./routes/app-config";
import { usage } from "./routes/usage";
import { soul } from "./routes/soul";
import { skills } from "./routes/skills";
import { heartbeat } from "./routes/heartbeat";
import { criticize } from "./routes/criticize";
import { github } from "./routes/github";
import { storage } from "./routes/storage";
import { generated, generatedFiles } from "./routes/generated";
import { notes } from "./routes/notes";
import { memory } from "./routes/memory";
import { monitor } from "./routes/monitor";
import { push } from "./routes/push";
import { calendar } from "./routes/calendar";
import { ingest } from "./routes/ingest";
import { channels } from "./routes/channels";
import { providers } from "./routes/providers";
import { threads } from "./routes/threads";
import { schedules } from "./routes/schedules";
import { mcp } from "./routes/mcp";
import { modules } from "./routes/modules";
import { m } from "./routes/m";
import { tempus } from "./routes/tempus";
import { dream } from "./routes/dream";
import { proactive } from "./routes/proactive";
import { spectreMode } from "./routes/spectre-mode";
import { shell } from "./routes/shell";
import { workspace } from "./routes/workspace";
import { pdfs } from "./routes/pdfs";
import { auth } from "./routes/auth";
import { permission } from "./routes/permission";

const app = new Hono();

app.onError(errorBoundary);
app.use("/api/*", coreAuth);

// ── Mounted route groups. As each Next group is ported to src/server/routes/,
//    add its `app.route("/api/<group>", <group>)` line here. (See PORTING.md.)
app.route("/api/health", health);
app.route("/api/models", models);
app.route("/api/app-config", appConfig);
app.route("/api/usage", usage);
app.route("/api/soul", soul);
app.route("/api/skills", skills);
app.route("/api/heartbeat", heartbeat);
app.route("/api/criticize", criticize);
app.route("/api/github", github);
app.route("/api/storage", storage);
app.route("/api/generated", generated);
// Top-level byte-serving for generated images (NOT under /api → not coreAuth-gated;
// browser access is still session-gated at the shell). Must be registered as its
// own path so the /generated/<name> URLs the brain embeds actually resolve.
app.route("/generated", generatedFiles);
app.route("/api/notes", notes);
app.route("/api/memory", memory);
app.route("/api/monitor", monitor);
app.route("/api/push", push);
app.route("/api/calendar", calendar);
app.route("/api/ingest", ingest);
app.route("/api/channels", channels);
app.route("/api/providers", providers);
app.route("/api/threads", threads);
app.route("/api/schedules", schedules);
app.route("/api/mcp", mcp);
app.route("/api/modules", modules);
app.route("/api/m", m);
app.route("/api/tempus", tempus);
app.route("/api/dream", dream);
app.route("/api/proactive", proactive);
app.route("/api/spectre-mode", spectreMode);
app.route("/api/shell", shell);
app.route("/api/workspace", workspace);
app.route("/api/pdfs", pdfs);
app.route("/api/auth", auth);
app.route("/api/permission", permission);

const port = Number(process.env.PORT) || 8788;
console.log(`[spectre-core/hono] listening on :${port}`);
// idleTimeout: 0 DISABLES Bun.serve's idle timeout (default 10s, max 255s). A
// durable agentic turn runs inside POST /api/threads/:id/run and sends NO bytes
// back until it finishes — on a slow/CPU backend that is minutes — so the default
// 10s (and even the 255s max) would have the SERVER close the connection mid-turn
// and fail the run. The core is loopback-only behind the CORE_TOKEN gate, so a
// disabled idle timeout carries no untrusted-client DoS exposure. (Gate #3.)
export default { port, fetch: app.fetch, idleTimeout: 0 };
