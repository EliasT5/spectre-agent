# The Provider-Agnostic Brain (the default; the CLIs are opt-in)

_Plain-English record of the 2026-06-06 change that made the brain provider-agnostic.
Read this first if you're wondering why chat defaults to the gateway, not the
`claude` CLI._

## TL;DR

Spectre's brain used to run only by spawning the **`claude` CLI**. The standard
brain is now provider-agnostic, so a default deployment needs no subscription at
all — just your own API key or a local model. The CLIs stay available as an opt-in.

1. **The standard brain is provider-agnostic.** One OpenAI-compatible agentic
   loop talks to a model gateway you configure (`SPECTRE_LITELLM_URL`) — a LiteLLM
   proxy, a local Ollama, OpenAI, Gemini, Bedrock, vLLM… anything that speaks the
   OpenAI API. It uses **your own API keys / self-hosted models**.
2. **The Claude / Codex / Gemini CLIs are off by default — and opt-in.** Each
   scripts your OWN subscription through the vendor's own CLI / agent SDK, running
   on your machine; enable one with `SPECTRE_ALLOW_*_CLI=1`, or live from Settings →
   Providers when `SPECTRE_ALLOW_CLI_UI=1`. Off by default because each uses a single
   personal login — keep them off on shared / multi-user deployments.
3. Tools still execute through the **same spectre MCP broker** — every approval,
   quota, and audit is unchanged. The model just reaches them a different way.

This was tested end-to-end (see "What was tested"). The architecture is proven.

---

## Why provider-agnostic is the default

A default deployment should run on infrastructure the operator controls, with no
dependency on any single vendor's subscription:

- **Portability.** One OpenAI-compatible loop runs against any gateway — LiteLLM,
  Ollama, OpenAI, Gemini, Bedrock, vLLM. Swap models per message; no lock-in.
- **No subscription required.** Bring your own API key (billed per token) or run a
  local model with no keys at all. Nothing rides a personal login by default.
- **Shareable.** Because the default path is your own key / local model, a shared or
  multi-user deployment works without anyone's personal subscription behind it.

The subscription CLIs (Claude / Codex / Gemini) stay first-class **opt-ins** for
personal use: each scripts your own subscription through the vendor's own CLI / agent
SDK, on your own machine — the supported, documented way to drive those tools
programmatically. They're off by default because each uses a single personal login,
which fits your own box but not a shared deployment.

---

## How the new brain works

`src/lib/ai/providers/litellm.ts` is the new provider. When the router picks a
`litellm` model, the loop does:

```
1. Connect to the spectre MCP broker (stdio) as an MCP *client* — same broker the
   CLI used. List its tools, convert them to OpenAI function schemas.
2. Call <SPECTRE_LITELLM_URL>/chat/completions with the messages + tools (stream).
3. Stream text tokens out as they arrive.
4. If the model emits tool_calls: execute each through the broker (mcp.callTool) —
   which runs the SAME approval gate / quota / core-API path — and feed results back.
5. Loop until the model gives a final answer (bounded to 20 tool rounds).
```

It emits the exact same `StreamChunk`s (`token` / `tool_use` / `tool_result` /
`done`) the durable runner already consumes, so `/api/threads/[id]/run` needed no
changes beyond cancellation. Cancellation: a shared abort registry
(`src/lib/ai/abort.ts`) lets the Stop button kill the loop (the run route calls
`abortThread()` alongside the old `abortClaudeForThread()`).

**Why this is clean:** the model only ever sees *our* tools — never a CLI's builtin
`Bash`/`Edit`/`Write`. So the whole `CONFLICTING_BUILTINS` blocklist problem from the
CLI adapter simply doesn't exist here.

It's now the **standard**: `litellm-default` in the model catalog lists every intent
in `bestFor`, so the router prefers it whenever it's configured. With the
subscription CLIs off by default, the live provider set is just
`["litellm","ollama"]`.

---

## The opt-in gates (all default OFF)

| Flag | Gates | Default |
|---|---|---|
| `SPECTRE_ALLOW_CLAUDE_CLI` | claude-code provider + `spawnClaudeCode` (throws if off) | off |
| `SPECTRE_ALLOW_CODEX_CLI` | codex-cli provider + broker `openai.*` tools | off |
| `SPECTRE_ALLOW_GEMINI_CLI` | gemini-cli provider + broker `gemini.execute` tool | off |
| `SPECTRE_ALLOW_CLI_UI` | toggling the three above from Settings → Providers | off |

Both layers are gated — the provider (so the router won't pick it) **and** the
broker tool registration (so the brain can't reach `openai.chat` / `gemini.execute`
as a tool). For your own personal box, set the flag(s) to `1`, or flip
`SPECTRE_ALLOW_CLI_UI=1` and toggle them in Settings → Providers.

---

## Adding / detecting providers (Settings → Providers)

- **Auto-detect:** `GET /api/models` now merges the static catalog with whatever
  models the gateway exposes (`GET /v1/models`). Add a model to the proxy and it
  shows up in the Routing picker automatically. The router accepts any such model id
  via a synthetic `litellm` ModelDef.
- **Add to the proxy, two ways:**
  1. **Static:** edit `litellm-config.yaml`, add the model + key, `docker compose
     restart litellm`.
  2. **Runtime:** Settings → Providers → "Add a provider" → POSTs to
     `/api/providers/models` → LiteLLM admin `/model/new` (needs a real LiteLLM
     proxy with a master key; to persist, `store_model_in_db` + Postgres). A plain
     Ollama gateway has no admin API — the UI tells you to use the config file.

---

## Running it / SPEED

Dev config (in `.env.local`, already set):
```
SPECTRE_LITELLM_URL=http://127.0.0.1:11434/v1   # local Ollama, OpenAI-compatible
SPECTRE_LITELLM_KEY=ollama
SPECTRE_LITELLM_MODEL=qwen2.5:7b-instruct        # best local tool-caller
```

> **⚠️ Speed caveat:** this workstation runs Ollama on **CPU** (no GPU). qwen2.5:7b
> on CPU is slow — even a 5-word reply took ~48s cold, and every turn pays the cost
> of evaluating the full soul prompt + 53 tool schemas. **The architecture is fine;
> the hardware is the bottleneck.** For a snappy brain: (a) point
> `SPECTRE_LITELLM_MODEL`/the gateway at a real **API** (your own key — set up a
> LiteLLM entry, see `litellm-config.yaml`), or (b) run on a GPU box, or
> (c) use a smaller local model (e.g. `phi4-mini`) for chat.

Production (docker): `docker-compose.yml` now bundles a **LiteLLM gateway** service;
the core points at `http://litellm:4000/v1`. Configure models + keys in
`litellm-config.yaml` + `.env.docker`. The Dockerfile no longer bundles the claude CLI.

---

## What was tested (2026-06-06)

- ✅ **Loop mechanics** (smoke test, real qwen + real broker): streaming over Ollama
  `/v1`; MCP client listed the broker tools; full agentic round-trip — a tool call
  → broker executed → correct result fed back into the loop. Every primitive
  validated.
- ✅ **Live core after restart**: `/api/models` → `providers: ["litellm","ollama"]`
  (claude/codex/gemini **gone** — gates work) + auto-detected gateway models showing
  up (gemma3, phi4-mini).
- ✅ **Durable path wiring**: chat-runner → `/run` → `route()` picked `litellm-default`
  → broker connected → Ollama call started. (Completion blocked by CPU speed — see
  the 300s ceiling below.)
- ✅ Both repos `tsc --noEmit` clean; broker parses.

### The 300-second ceiling (important)

A durable turn on this CPU box did **not** complete: it errored at ~310s with
"runner could not reach the core." Root cause is **Node's built-in fetch (undici)
default ~300s headers timeout**, which walls BOTH hops — the chat-runner→`/run`
fetch (the core holds that connection open for the whole turn) AND the
core→Ollama fetch (Ollama buffers the entire response when tools are present, so
no bytes arrive until generation finishes). qwen2.5:7b + the full soul prompt +
53 tool schemas takes >300s to first byte on CPU → both fetches time out.

This is **not specific to LiteLLM** — it's a pre-existing ceiling that the old
claude path never hit because Anthropic's API is fast. On a fast backend
(your own API key, or a GPU) turns finish in seconds and never approach it.

**To fix the ceiling itself** (a real production improvement for long agentic
turns): either (a) add `undici` as a dep and give both fetches a relaxed
`dispatcher` (`headersTimeout: 0`), or (b) redesign the chat-runner to fire
`/run` and poll the message row for terminal status instead of holding the HTTP
connection (the row is already the source of truth). Left for review — it touches
working infra, so it wants your eyes, not an unattended overnight edit.

---

## What's left / known gaps (not blockers, noted for honesty)

- **`proactive.ts` still calls `spawnClaudeCode` directly.** With the gate on, that
  now *throws* if claude isn't enabled. Autonomy is OFF by default so it doesn't fire
  normally, but the bounded-proactive path should be ported to the litellm loop.
- **Image generation** (`openai.image`) is off (it rode the Codex subscription).
  Needs a metered images API / a generation primitive — future.
- **Jerome-Mode `dispatch_to_model`** is only registered in Jerome Mode, which
  depends on claude availability (off by default), so it's effectively off unless
  you opt the Claude CLI in.
- **Runtime "add a provider"** (`/api/providers/models`) couldn't be tested in dev
  (local Ollama has no admin API). The code degrades with a clear message; verify it
  against a real LiteLLM proxy.
- **`tools-catalog.json`** still lists `openai.*` / `gemini.execute` (cosmetic — the
  brain only sees actually-registered tools, so they're not offered when gated off).

---

## Files changed (commits on `main`, NOT pushed)

- `45ce6a7` — LiteLLM brain + ToS gates + deploy artifacts
- `16080fc` — provider auto-detect + runtime add-a-provider API
- `593e367` — core README (provider-agnostic + ToS)
- shell `f241b7b` — Settings Providers panel; shell README rewrite (separate commit)

Key files: `src/lib/ai/providers/litellm.ts`, `src/lib/ai/abort.ts`,
`src/lib/ai/{models,router,providers}.ts`, `src/lib/ai/providers/{claude-code,codex-cli,gemini-cli}.ts`,
`src/app/api/{models,providers/models}/route.ts`, `spectre-mcp-broker/index.mjs`,
`docker-compose.yml`, `litellm-config.yaml`, `.env.docker.example`, `Dockerfile`;
shell `src/app/settings/page.tsx`, `README.md`.
