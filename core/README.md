# spectre-core

The **core** of Spectre — the headless "brain." Fully open source under the
project's MIT license (see the repo-root `LICENSE`), built from source.

The shell lives at the repo root and is the only browser-facing surface. It
proxies `/api/*` to this core.

## What it is

A headless Next.js API service plus its satellites:

- **Brain:** a **provider-agnostic, ToS-clean** agentic loop
  (`src/lib/ai/providers/litellm.ts`) — one OpenAI-compatible loop over a LiteLLM
  gateway (your keys / self-hosted models), executing tools through the MCP
  broker. Plus the multi-model router, durable streamed chat, semantic +
  cross-thread memory, the permission/quota layer, bounded autonomy, the
  self-evolution Workshop, SkillOpt, monitoring, scheduling.
- **Satellites** (separate processes via the same image): `worker/chat-runner`,
  `worker/scheduler`, `worker/worker` (Workshop), and `spectre-mcp-broker`.

> **The subscription-driven CLIs are off by default.** The default brain uses
> metered API keys / self-hosted models via the gateway. The Claude / Codex /
> Gemini CLIs run on your own personal subscription instead, so they're opt-in:
> switch them on with the env flags (`SPECTRE_ALLOW_CLAUDE_CLI` / `_CODEX_CLI` /
> `_GEMINI_CLI`) or live from Settings → Providers when the core runs with
> `SPECTRE_ALLOW_CLI_UI=1`. **Use at your own risk** — depending on the vendor and
> your usage, driving a consumer subscription this way may run against its terms
> and could flag the account; that's part of why it's off by default. See the
> spectre-agent README footnote.

## Security model (do not weaken)

- Binds **loopback only** (`127.0.0.1:8787`) and is **never** exposed on a
  public interface. In Docker, the container binds `0.0.0.0` internally and the
  compose port mapping (`127.0.0.1:8787:8787`) enforces loopback exposure.
- Every request must carry a secret **`CORE_TOKEN`**; only the shell holds it,
  and the browser never sees it. `/api/health` is the only unauthenticated route.
- The core can run code/shell commands on the host — treat `CORE_TOKEN` and the
  host as trusted-only.

## Running

Configure from `.env.docker.example`. Apply the database schema
(`supabase/_apply_all.sql`) to your own Supabase project, then:

```bash
npm install
npm run build
npm run start      # core API on 127.0.0.1:8787
```

In production use the provided `Dockerfile` / `docker-compose.yml` (core +
satellites). See `docs/M2-DOCKER.md`.

## Conventions

This runs a bleeding-edge Next.js — read `AGENTS.md` before changing routes.
Skills, tools, and MCP live in `skills/`, `spectre-mcp-broker/`, and `soul/`;
add-on **modules** are a separate system owned by the shell.
