# Spectre Agent — Architecture Map

> A whole-repo mental model: what Spectre is, how the processes fit together, how one
> chat turn flows end-to-end, and where the sharp edges are. Read this once and you can
> navigate the codebase. Generated 2026-07-07 from a subsystem-by-subsystem survey; if a
> detail here conflicts with the code, the code wins — please update this doc.

## 1. What Spectre is

Spectre is a self-hosted, single-user, provider-agnostic personal AI agent you extend yourself. A public, PIN-gated Next.js "shell" (with a 3D voxel-blob home screen) is the only user-facing surface; it proxies everything to a private, loopback-only Bun/Hono "core" that holds all business logic, storage, and model routing. The trust story is deliberate: readable code over a sealed binary, secrets never leave the core, and every sensitive tool call passes a human-approval gate. Note the pervasive naming split — the product is **Spectre**, but the agent persona and much of the code is branded **Jerome** (env vars are `SPECTRE_*`).

## 2. System topology

All host port binds are `127.0.0.1`. The shell/edge is the only user-facing surface; the core trusts `CORE_TOKEN` alone.

```
                          Browser (PIN + HMAC session cookie)
                                     │  :3100 (or Caddy edge :8090)
                                     ▼
                 ┌─────────────────────────────────────┐
                 │  SHELL  (Next.js 16, spectre-shell)  │  no secrets, no AI logic
                 │  src/proxy.ts → /api/[...path]        │  injects x-spectre-core-token
                 └─────────────────────────────────────┘
                                     │  http://core:8787  (loopback)
                                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  CORE  (Bun/Hono, spectre-core:local)  coreAuth gate       │
        │  ~34 /api/* route groups; the agent turn loop lives here    │
        └──────────────────────────────────────────────────────────┘
          │ spawns per-turn        │ SPECTRE_LITELLM_URL      │ createServiceSupabase()
          ▼ (stdio MCP)            ▼                          ▼
   ┌───────────────┐        ┌────────────┐            ┌──────────────────┐
   │ MCP BROKER    │        │  LiteLLM   │──▶ Ollama   │  SUPABASE         │
   │ spectre-mcp-  │        │  gateway   │  (host)     │  Postgres+pgvector│
   │ broker (tools)│        │  :4000     │──▶ API keys │  PostgREST+       │
   └───────────────┘        └────────────┘  (13 prov.) │  Realtime + Kong  │
     │ POST /permission/request                         │  :8000 (local) or │
     │ screenshot → shotter:8008                        │  cloud project    │
     ▼                                                  └──────────────────┘
   Human approval gate (in-core permission broker)               ▲
                                                                 │ (rows = the queue)
   ┌──────────── WORKERS (same image, different entrypoints) ───────────────┐
   │ chat-runner  : claims 'queued' msg rows → POST core /run                │
   │ scheduler    : polls /api/schedules/claim → dispatches jobs             │
   │ channel-runner: Telegram/WhatsApp/Discord in+out (Discord Gateway WS)   │
   └────────────────────────────────────────────────────────────────────────┘
   MONITOR (NOT in compose; systemd .timer oneshot every 5 min): vitals→LLM→remediate

   SIDECARS (compose profiles):
     shotter        :8008  Playwright/Chromium screenshots (screenshot profile)
     workspace      :8010  git/IDE backend, sandbox slots + trusted folders (workspace)
     code-server    :8080  embedded VS Code, same-origin via Caddy edge (workspace)
```

Key edges: browser→shell (PIN/session), shell→core (`x-spectre-core-token`), core→LiteLLM (`LITELLM_MASTER_KEY`), core↔Supabase (service role), core→broker (stdio MCP, per turn), broker→core (`X-Spectre-Service-Token` + `CORE_TOKEN`), workers↔Supabase rows + core HTTP, shell→workspace (`x-workspace-token`).

## 3. The request lifecycle (one chat turn)

1. **UI send** — `src/app/chat/page.tsx` posts to `/api/threads/:id/enqueue`. The browser never calls `/run`; it only subscribes to an SSE row stream and watches the message row fill.
2. **Proxy hop** — `src/proxy.ts` (Next 16 middleware, **renamed from middleware.ts**) verifies the HMAC session cookie, then `src/app/api/[...path]/route.ts` forwards to `http://127.0.0.1:8787` injecting `x-spectre-core-token`, streaming bodies untouched.
3. **Enqueue** — `core/src/server/routes/threads.ts` inserts a `done` user message + a `queued` assistant placeholder.
4. **Worker claim** — `core/worker/chat-runner.mjs` CAS-claims the `queued` row (single winner), sets a lease, and POSTs `/api/threads/:id/run`.
5. **Turn loop** — `threads.ts` `post('/:threadId/run')` (~lines 334-598) sets status `running`, runs concurrent RAG (memory recall, cross-thread, PDF via `core/src/lib/ai/pdf-rag.ts`, recent issues), assembles the system prompt via `core/src/lib/ai/soul.ts:buildSystemPrompt()` (stable prefix = cache breakpoint) + a trust-boundary block, then `checkSpendCap()`.
6. **Route** — `core/src/lib/ai/router.ts:route()` picks the model (explicit hint or Auto scoring).
7. **Stream** — `core/src/lib/ai/providers.ts:streamChat()` dispatches to a provider; default is `core/src/lib/ai/providers/litellm.ts:streamLiteLLM()`, an OpenAI-compatible function-calling loop (`MAX_TOOL_ITERATIONS=20`).
8. **Tool call** — the loop spawns/connects `core/spectre-mcp-broker/index.mjs` over stdio, exposes its tools as function schemas, and dispatches each `tool_use` back through the broker.
9. **Permission gate** — for gated tools the broker POSTs `/api/threads/:id/permission/request` (`verifyBrokerToken`) → `core/src/lib/permission/broker.ts:enqueue()` consults `tool_policies`/quotas, else blocks on a pending `reqId`. `command-scan.mjs` pre-screens bash (block/flag/ok).
10. **Approval UI** — `src/app/chat/page.tsx` **polls** `/api/permission/pending` every 1.5s and POSTs the decision to `/permission/:reqId` (`resolvePermission()`).
11. **Persist + relay** — the run loop flushes `{content, tool_calls}` to the message row every ~400ms; `GET /:id/stream` relays each Supabase Realtime row UPDATE over SSE to the browser. On `done` it records tokens and fires `maybeCompactThread` + `learnFromExchange`.

## 4. The module system (the headline feature)

A module adds a capability without touching core code. **Two module models coexist in code — this is the single biggest documentation trap.** The current/canonical one is the **manifest-based v2 system** (README + code); an older **route-based** model is described in `docs/MODULES.md` (a Next.js route in `src/lib/modules.ts` + `spectre.*`). Build against the manifest system below.

**Three UI modes** (`jerome.module.json`, schemaVersion 2):
- **data** — UI shipped as declarative data. `src/app/m/[moduleId]/page.tsx` → `src/components/ui/SchemaRuntime.tsx` renders a `UISchemaV2` on the shared Glass-HUD kit. Zero module React. Pure types/helpers live in `src/components/ui/schema-v2.ts`.
- **code** — untrusted ESM in a sandbox. `src/components/ui/ModuleFrame.tsx` fetches the bundle as text, SHA-384 SRI-verifies it, loads it into an `allow-scripts` opaque-origin iframe (`src/app/sandbox/host/route.ts` serves a per-request-nonce CSP with `connect-src 'none'`), and services RPC over a `MessageChannel` via `src/components/ui/module-bridge.ts` (token bucket, in-flight cap). Security is CSP + SRI, **not** auth — `/sandbox` is a public path.
- **native** — `router.replace(m.route)` (built-ins only).

**Registration & load** — the live registry (`core/src/server/routes/modules.ts`, `GET /api/modules`) merges three provenance tiers: compiled `BUILTINS` (7: chat/memory/settings/monitor/tempus/workspace/library) **<** data-dir drop-ins (`<SPECTRE_DATA_DIR>/modules/<id>/module.json`) **<** DB `module_installs`. `core/src/lib/modules/manifest.ts` is the canonical zod schema; ed25519 signing (`signing.ts`) is **OFF by default** (trusts everything until `SPECTRE_MODULE_TRUSTED_KEYS` is set).

**Backend dispatch** — `/api/m/:id/*` → `core/src/server/routes/m.ts`: path-guard → trust gate → `resolveBackend()` → `matchRoute()` → `core/src/lib/modules/bindings.ts:runBinding()`, a **switch over a closed `BINDING_KINDS` vocabulary** (no module code runs; `handler`/`schedule.*` throw `ModuleNotImplemented`). `core/src/lib/modules/ctx.ts:buildCtx()` is the entire trust boundary — closures only, forced `module_id` namespacing, SSRF-guarded `fetch`, permission-gated + audited.

**SDK surface** — modules call `spectre.*` (`src/lib/sdk.ts`), a thin `fetch('/api'+path)` wrapper. The gate is `src/components/ui/sdk-calls.ts:SDK_CALLS` — a **read-only allowlist reused by both data and code modes**. Writes (`memory.add`, `chat.*`, `config.set`) exist in the SDK but are physically absent from `SDK_CALLS`, so modules cannot call them.

**Surface as UI orbs + tools** — `useModules()` (`src/lib/module-registry.ts`) feeds both the desktop sidebar nav and the 3D blob slots. `src/lib/blob-layout.ts` persists which module sits in which blob (≤10 slots) to core KV `app_config/blob_layout`. On the tool side, `core/spectre-mcp-broker/tools-catalog.json` is the single tool catalog shared by broker and core.

## 5. Subsystem index

| Area | One-liner | Key files | Main edges |
|---|---|---|---|
| **shell:app-tabs** | PIN-gated Next 16 App Router; one folder per tab, thin proxy to core. | `src/proxy.ts`, `src/app/api/[...path]/route.ts`, `src/app/chat/page.tsx`, `src/app/settings/page.tsx` | core `/api/*`, workspace-service, MS Graph OAuth |
| **shell:blob-3d** | 16k-voxel WebGL "blob" home screen; slots/colors from persisted layout KV. | `src/components/blob/BlobScene.tsx`, `src/components/blob/Blob.tsx`, `src/lib/blob-layout.ts` | `/api/app-config/blob_layout`, `/api/modules`, R3F/drei |
| **shell:ui-kit+sdk** | Glass-HUD kit + UI-Schema runtime + sandbox + `spectre.*` SDK. | `src/components/ui/kit.tsx`, `src/components/ui/SchemaRuntime.tsx`, `src/components/ui/sdk-calls.ts`, `src/lib/sdk.ts` | core via proxy, sandbox `MessageChannel` |
| **core:hono-server** | Bun/Hono, ~34 route groups behind one `CORE_TOKEN` gate. | `core/src/server/main.ts`, `core/src/server/mw.ts`, `core/src/server/routes/threads.ts` | Supabase, LiteLLM, broker, webhooks |
| **core:ai-model-backends** | Provider-agnostic model layer + user-taught modular backends. | `core/src/lib/ai/router.ts`, `core/src/lib/ai/providers.ts`, `core/src/lib/ai/backends/registry.ts`, `core/src/lib/ai/models.ts` | LiteLLM admin API, Postgres `model_backends`, Ollama |
| **core:ai-agent-loop** | The durable turn loop: RAG prompt → stream → tool loop → persist row. | `core/src/server/routes/threads.ts`, `core/src/lib/ai/providers/litellm.ts`, `core/src/lib/permission/broker.ts` | Supabase Realtime SSE, broker subprocess |
| **core:modules+permission** | Manifest → gated declarative capability; broker approval gate. | `core/src/server/routes/m.ts`, `core/src/lib/modules/ctx.ts`, `core/src/lib/modules/manifest.ts`, `core/src/lib/permission/broker.ts` | `module_kv`/`module_rows`, `tool_policies` |
| **core:data+integrations** | Supabase gateway, PDF-RAG, workspace fs backend, MS Graph. | `core/src/lib/supabase/server.ts`, `core/src/lib/ai/pdf-intake.ts`, `core/src/lib/workspace-server/path-guard.ts`, `core/src/lib/ms-graph/client.ts` | Supabase, MS Graph, GitHub `gh`/`git` |
| **core:skills+soul** | Editable brain files re-read every turn to build the system prompt. | `core/src/lib/ai/soul.ts`, `core/soul/*.md`, `core/skills/*/SKILL.md`, `core/src/lib/ext/dirs.ts` | broker `skill.read`, `skill_usage` table |
| **core:worker+monitor** | 4 workers + oneshot monitor coordinating via Supabase rows. | `core/worker/chat-runner.mjs`, `core/worker/scheduler.mjs`, `core/worker/channel-runner.mjs`, `core/monitor/monitor.mjs` | Supabase rows, core HTTP, channels, systemd |
| **core:mcp-broker+sidecars** | stdio MCP tool surface + screenshot & workspace HTTP sidecars. | `core/spectre-mcp-broker/index.mjs`, `core/spectre-mcp-broker/command-scan.mjs`, `workspace-service/src/routes.ts`, `screenshot-sidecar/shotter.mjs` | core permission gate, gemini/codex CLIs, GitHub |
| **infra:deploy** | Docker Compose stack + interactive Node installer. | `docker-compose.yml`, `installer/install.mjs`, `litellm-config.yaml`, `core/Dockerfile` | Ollama host, LiteLLM, Supabase, Caddy edge |
| **docs:product-intent** | Prose defining intent, trust model, module story, roadmap. | `README.md`, `docs/ARCHITECTURE.md`, `DESIGN.md`, `docs/MODEL-ROUTING.md` | — |

## 6. Model routing

Entry: `core/src/lib/ai/router.ts:route(userContent, hint)`. `hint` resolves in order (`docs/MODEL-ROUTING.md`):

1. `gateway:<model>` → forces the LiteLLM tools path.
2. Exact `MODEL_CATALOG` id.
3. Enabled `cli-command` brain (via `getBackendSync`).
4. Live Ollama model (`ollamaModelsSync`, fast/tool-less) — runs **before** the catch-all.
5. **LiteLLM catch-all** — any unrecognized hint becomes a synthetic gateway request when LiteLLM is configured (so typos fail only at call time with a 404).

**Auto** (no hint): `classifyIntent()` (regex → 1 of 8 intents) then `scoreModel()` over available models (`bestFor +30`, per-capability `+10`, speed/cost tiebreak, `+1` local-CLI nudge). Because the litellm-default declares `bestFor` for **every** intent (+30 each), Auto ≈ "always the gateway default" unless a hint overrides.

**One Streamer contract** — every backend (LiteLLM loop, claude-code CLI, Ollama, cli-text, Jerome orchestrator) normalizes to `AsyncGenerator<StreamChunk>` (`token|tool_use|tool_result|done`), so the turn loop is provider-agnostic. Adding a provider = a streamer + a `Provider` union member.

**Modular backends** — `POST /api/providers/backends` validates a zod `ModelBackend` (`api`/`cli-server`/`cli-command`), then for `api` registers on LiteLLM (`/model/new`) and for `cli-server` spawns/supervises a process; all dual-written to Postgres `model_backends` + data-dir `backends.json` (the broker reads the file, has no DB). `SPECTRE_ALLOW_CLI_BACKENDS=1` gates the RCE-by-design kinds.

## 7. Notable patterns & conventions

- **Thin-shell / heavy-core** — the shell is UI + PIN gate + streaming proxy; adding a core endpoint needs no shell route. Enforced in `CONTRIBUTING.md`.
- **DB-row-as-queue** — no in-memory queue; workers CAS-claim rows (`update...eq(status).select()`, empty = lost race) with lease + heartbeat + stale-reclaim. Exactly-once outbound via `messages.delivered_at`.
- **StreamChunk universal contract** + **one closed SDK allowlist** (`sdk-calls.ts`) reused for data + code modes.
- **Stable-vs-volatile prompt split** — `buildSystemPrompt()` returns the cacheable prefix; `cacheBreak = prefix.length` marks the Anthropic prompt-cache breakpoint; RAG/trust blocks follow.
- **Files-as-config brain** — soul + skills re-read from disk every turn; edits are live next message. Built-in-overlaid-by-user overlay (`ext/dirs.ts`) for skills/tools/mcp/modules/backends.
- **Fail-closed for authority, fail-soft for availability** — approval/auth deny on any doubt; RAG/probes/model-fetches degrade rather than 500.
- **Defense-in-depth for untrusted code** — SRI → opaque origin → port-only RPC → rate caps → opaque errors. Path-guards (realpath + symlink walk) + `safeSpawn` (shell:false, env allowlist) + SSE redaction for workspace/shell.
- **Glass-HUD kit + globals.css** — components carry structure only; all color/glass from CSS custom properties, mirrored into the sandbox via `src/lib/tokens.ts`.
- **One image, many entrypoints** — `spectre-core:local` built once, reused by chat-runner/scheduler/channel-runner with different `command:`.
- **Codenames** — "Jerome" = persona/orchestration/self-evolution mode; "Workshop" = the self-evolution worker; "Fable" = a Claude design pass.

## 8. Gotchas & sharp edges

**Naming / discovery**
- Product = **Spectre**, persona/code = **Jerome** (branch prefix `jerome/`, PR author, `@jerome` mentions, single MCP server "jerome"), env = `SPECTRE_*`. Rename in progress.
- Auth gate is `src/proxy.ts`, **not** `middleware.ts` (Next 16 rename). Grepping for middleware.ts wrongly concludes auth is unwired.

**Two-of-everything drift**
- **Two module systems** (manifest-based vs `docs/MODULES.md` route-based) — build against the manifest one.
- **Two Workspace implementations** — `workspace-service/src/*` sidecar vs `core/src/lib/workspace-server/*` used by `core/src/server/routes/workspace.ts` directly. Can drift.
- **Two compose files** — root `docker-compose.yml` (real product stack) vs `core/docker-compose.yml` (dev stack referencing a phantom `spectre-worker` binary that `build.mjs` never compiles).
- **Two `litellm-config.yaml`** (root + core, different sizes) and two `computeNextRun` (worker `scheduler.mjs` ignores timezone/run_at; server `@/lib/schedules` honors them → daily jobs can drift).

**Security surprises**
- Approval chips are **polled**, not pushed — `registerNotifier` is dead code across broker(s); UI hits `/api/permission/pending` every 1.5s.
- `POST /:threadId/permission/:reqId` (resolve, `threads.ts:763`) is gated only by the blanket `coreAuth` (CORE_TOKEN) — unlike the *request* side (`threads.ts:734`), which additionally requires the broker service token (`verifyBrokerToken`). Not a public hole (core is loopback + CORE_TOKEN), but the resolve is trusted to any CORE_TOKEN holder rather than bound to the approving session — asymmetric with the request side.
- Module signing **OFF by default** (empty keyring trusts everything). Set `SPECTRE_MODULE_TRUSTED_KEYS` before accepting third-party modules.
- `gemini.execute`/`openai.*` broker adapters hand the child the broker's **full env** (incl. `CORE_TOKEN`, Supabase keys) — unlike the bash tool's allowlist.
- `command-scan.mjs` is regex-only (Unix-shaped) and bypassable; it's a gate above human approval, not a sandbox.
- Workspace shell + code-server = RCE on trusted bind-mounts for anyone past the shell PIN; never move binds off loopback without HTTPS.
- Trusted-folder finalize commits as `spectre@local.invalid` and **pushes directly to the current branch** (a folder on `main` gets a direct push to main, no PR).
- `push.ts POST /send` guarded only by `CORE_TOKEN`, not the service token.

**Half-built / dead**
- Workspace "Jerome" chat is a non-functional affordance; Memory Notes/Soul/Skills sub-tabs are stubs.
- Pose/emote machinery in the blob is fully dead (`poses/index.ts` intentionally empty); audio equalizer inert; every blob is violet (`colorForIndex` is a no-op).
- Stash isn't persisted — `ensurePlaced()` re-drops modules on reload.
- Code-mode module `mount()` cleanup fns ignored; `handler`/`schedule.*` bindings throw 501.
- `autonomyGate` covers only some tools (`memory.delete`, `note.*`, `todo.*`, `tempus.*`, `schedule.*` have **no** quota gate).
- Azure Key Vault vestigial — `loadSecrets()` only called from `instrumentation.ts` which the Bun `main.ts` never imports; `store.ts`/`pdfjs-loader.ts` are stranded `'use client'` files in the headless core.
- `scheduler.finishJob` sets `next_run_at=null` on failure → the `/claim` `lte` query never re-selects it, so **failed recurring jobs silently stop rescheduling**.
- `target_type` mismatch: create API allows only `chat|workshop|notify`, but `scheduler.mjs` dispatches `dream/proactive/skillopt/skill_curation` (SQL-seeded only).

**Operational**
- ~300s undici `headersTimeout` walls slow local/CPU agentic turns (documented, unfixed).
- `proactive.ts` still calls `spawnClaudeCode` directly (throws when the CLI gate is off) — masked only because autonomy is off by default.
- All approval/notify/abort state is module-level in-memory — a core restart drops in-flight approvals; design assumes single-process.
- Cloud Supabase path does **not** auto-apply schema (prints paste instructions); local JWTs have 10-year expiry.
- Discord `MESSAGE_CONTENT` is a privileged intent — if unset, messages arrive empty and are silently dropped.
- Inconsistent `SPECTRE_APP_URL` defaults across processes (:3000 vs :8787) — harmless in compose, a footgun standalone.
- `notes/` are gitignored and contain live secrets (running box, PIN) — never surface publicly.

## 9. Where to start reading

1. **`README.md`** — product intent, the module story, the Tally manifest example.
2. **`docs/ARCHITECTURE.md`** — the shell↔core↔gateway security walkthrough with real file names.
3. **`src/app/api/[...path]/route.ts`** + **`src/proxy.ts`** — the entire shell→core contract and the auth gate.
4. **`core/src/server/main.ts`** + **`core/src/server/mw.ts`** — how the core mounts routes and enforces `CORE_TOKEN`.
5. **`core/src/server/routes/threads.ts`** — the agent turn loop (the hot path); read `post('/:threadId/run')`.
6. **`core/src/lib/ai/providers/litellm.ts`** — the default agentic tool loop.
7. **`core/src/lib/ai/router.ts`** — model selection (hint precedence + Auto scoring).
8. **`core/spectre-mcp-broker/index.mjs`** + **`core/src/lib/permission/broker.ts`** — the tool executor and the human-approval gate.
9. **`core/src/server/routes/m.ts`** + **`core/src/lib/modules/ctx.ts`** — module dispatch and the trust boundary.
10. **`docker-compose.yml`** — the process/container graph that ties it all together.
