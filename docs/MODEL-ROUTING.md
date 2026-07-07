# Model routing & the picker

How Spectre decides which provider actually runs a given model, and how the model
list stays honest.

---

## Routing precedence

`route(hint)` (`core/src/lib/ai/router.ts`) resolves a selected model in order:

1. **`gateway:<model>`** → force the LiteLLM path (the agentic, tool-using loop) —
   this is the `· tools` picker variant.
2. **Static catalog** entry (`MODEL_CATALOG`) whose provider is available.
3. **Live Ollama model** (pulled locally) → the fast, tool-less **ollama** provider.
   Checked *before* LiteLLM so local models aren't sent to the gateway.
4. **A registered `cli-command` brain** → the `cli-text` (chat-only) streamer.
5. **LiteLLM catch-all** → any model the gateway exposes (`/v1/models`), incl.
   runtime-added `api` / `cli-server` backends.

## Fast vs. tools (local models)

Each tool-capable local model shows **twice** in the picker:

| Entry | Route | Speed | Tools |
|-------|-------|-------|-------|
| **Qwen 2.5 7B** | Ollama direct | fast (~1–4 s warm) | ❌ chat-only |
| **Qwen 2.5 7B · tools** (`gateway:qwen2.5:7b-instruct`) | LiteLLM agentic loop | slower | ✅ shell/files/memory |

You pick the route by picking the entry — no toggle. Models Ollama can't tool-call
(gemma3, deepseek-r1) get **no** `· tools` variant (it would just error). Warm
models via `OLLAMA_KEEP_ALIVE` (e.g. `1h`) to avoid cold reloads.

## The list only shows what you've *added*

`GET /api/models` no longer lists the whole aspirational catalog. A catalog entry is
emitted only if its provider is **configured** ("added"): a CLI enabled/authenticated,
an API key set, the gateway/Ollama up. Never-configured entries (CLIs off, no key,
Jerome without Claude) are **hidden** — not greyed. A model that *was* added but is
now failing (key rejected, needs re-login) still shows, **greyed with a reason**. The
chat picker shows only usable models; embedders and the duplicate gateway-default are
filtered out.

## Custom display names

Rename any model inline in **Settings → Models**. Stored in `app_config.model_labels`
(`{ "<model id>": "Name" }`) and applied as a final override in `GET /api/models`, so
it covers catalog, detected, Ollama, API, and `· tools` variants. Clear the field to
reset.

## Weak-model tool-call recovery

Small local models sometimes emit a tool call as **text** (a JSON blob) instead of via
the structured channel. When a LiteLLM turn ends with no structured call but the text
contains a JSON tool-call matching a **real** tool name, Spectre recovers it, executes
the tool, and renders proper `tool_use`/`tool_result` chips
(`core/src/lib/ai/providers/litellm.ts`). It's a safety net, not a cure — the durable
fix is fewer tools per model (see `notes/` backlog) or a stronger model.

## Monitor severity

A failed chat turn is a **per-turn** error (you already see it in chat), so it's logged
as a `warning` with no phone push — not `critical`. `critical` is reserved for infra
failures (DB/gateway down), keeping the Monitor's critical count meaningful
(`core/src/server/routes/threads.ts`).

Key files: `core/src/lib/ai/router.ts`, `core/src/lib/ai/providers/ollama.ts`
(sync model cache), `core/src/server/routes/models.ts` (surfacing, `· tools` variants,
only-added, rename), `litellm-config.yaml`.
