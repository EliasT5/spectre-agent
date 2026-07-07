# Model backends & CLI brains

Spectre's brain is modular: you add the models it can use at runtime, from
**Settings → Providers**, with no file edits or restarts. A *backend* is a model
Spectre can talk to; a *CLI brain* is a subscription CLI (Claude/Codex/Gemini) run
locally on your own account.

---

## Model backends (`/api/providers/backends`)

A backend has one **kind** (how Spectre reaches it) and one or more **roles**
(how you use it).

### Roles
- **Brain** — appears in the model dropdown; you chat with it directly.
- **Dispatch tool** — *not* in the dropdown; the current brain can call it mid-turn
  (`dispatch.<id>`) to get another model's take (multi-model orchestration).

### Kinds
| Kind | You provide | Brain | Dispatch | Tool-use as a brain |
|------|-------------|:-----:|:--------:|---------------------|
| **api** | endpoint-type + key + endpoint | ✅ | optional | ✅ full (rides the LiteLLM/OpenAI loop) |
| **cli-server** | a command that runs an OpenAI-compatible server (ollama/llama.cpp/vLLM/LM Studio) | ✅ | optional | ✅ full |
| **cli-command** | a raw command + flags | ✅ (text-mode) | ✅ | ❌ chat-only as a brain; agentic only when *called via* dispatch by an agentic brain |

- **api** → registered on the LiteLLM gateway. `endpointType` (`openai` /
  `anthropic` / `gemini` / `azure` / `openai-compatible`) maps to the correct
  provider prefix; the key is forwarded to the gateway and **never stored in
  Spectre's registry** (only non-secret metadata + the gateway model id are kept).
- **cli-server** → Spectre supervises the process (or, in Docker, registers a
  host-run server at `host.docker.internal:<port>`), then points LiteLLM at
  `http://…:<port>/v1`. Full tool-use + streaming for free.
- **cli-command** → a text CLI. As a **brain** it's chat-only (spawn per turn,
  prompt in → stdout out, via the `cli-text` streamer). As a **dispatch tool** it's
  registered in the MCP broker (`dispatch.<id>`) so an agentic brain can hand it a
  prompt.

### Storage & the broker
Backends are **dual-written**: the Postgres `model_backends` table (durable,
service-role RLS) **and** `<dataDir>/backends/backends.json` — because the
mcp-broker has no DB access and reads that file to register `dispatch.<id>` tools.
A synchronous in-memory snapshot lets the router resolve backend hints without a DB
round-trip. All reconciled on boot (`hydrateBackends()`).

### Security gate
`cli-server` and `cli-command` spawn **operator-supplied commands** (RCE by
design), so they are gated behind `SPECTRE_ALLOW_CLI_BACKENDS=1` (default off).
`api` backends only register a gateway model and are ungated. Spawned processes
get a **clean env** (never `CORE_TOKEN` / Supabase keys) and bind loopback only.

### Endpoints
- `POST /api/providers/backends` — add (validate → dispatch on kind; `dryRun:true` = Test).
- `GET /api/providers/backends` — list (with cli-server status).
- `PUT /api/providers/backends/:id` `{enabled}` — enable/disable.
- `DELETE /api/providers/backends/:id` — remove (deregisters from LiteLLM / stops the process).

Key files: `core/src/lib/ai/backends/*` (schema, litellm-map, registry, supervisor,
gate, cli-exec, cli-text-streamer, litellm-admin), `core/spectre-mcp-broker/cli-dispatch.mjs`,
`core/supabase/model_backends.sql`, `core/src/server/routes/providers.ts`.

---

## Subscription CLI brains (Claude / Codex / Gemini)

These run a vendor CLI locally on **your** subscription. They have **deep agentic
integration** (native tool-use, streaming, sessions) — unlike the generic
`cli-command` path. Off by default; enable per-CLI in **Settings → Providers**
(requires `SPECTRE_ALLOW_CLI_UI=1`).

Everything is settable **from the UI, no file edits**:
- **Binary / path** — type `claude` (or a full path); Spectre spawns that. Set via
  `PUT /api/providers/cli/bin`. Resolved at spawn time (`getCliBin`), so it takes
  effect with no restart. The card trends **default-none**: a CLI shows once it's
  *added* (enabled, or has a token/path).
- **Auth token** — paste the token (e.g. from `claude setup-token`) into the field;
  stored server-side (`app_config.cli_tokens`, never returned by the API) and
  injected into the CLI's env at spawn time. Set via `PUT /api/providers/cli/token`.
- **Enable** — `PUT /api/providers/cli` `{enabled}`.

### Running CLIs in the containerized core
The shipped core image is minimal (no node, no CLIs). To use a CLI *brain* in
Docker, bundle it into the image with the opt-in build arg:

```bash
INSTALL_CLAUDE_CLI=1 docker compose up -d --build core
```

That adds node + `@anthropic-ai/claude-code` to the image. Then set the token in
Settings and toggle Claude on. (Host-run cores don't need this — the CLIs are on
your PATH already.)

Key files: `core/src/lib/ai/cli-gate.ts`, `core/src/lib/ai/providers/claude-code.ts`,
`core/Dockerfile` (`INSTALL_CLAUDE_CLI`), `docker-compose.yml` (build arg).

> **Note:** small local models are unreliable at agentic tool-use with a large tool
> surface. For tools, prefer a CLI brain (Claude) or a strong API model; use local
> Ollama models for fast chat. See [MODEL-ROUTING.md](MODEL-ROUTING.md).
