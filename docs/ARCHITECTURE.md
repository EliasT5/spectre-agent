# Architecture & Security

A short, source-backed walkthrough of how Spectre is wired and what the agent
can and can't touch. Everything here is verifiable in this repo — the shell at
the root and the core in [`core/`](../core/) are both open source. Trust here
comes from readable code, not a sealed binary.

## Two halves, one repo

```
browser ──PIN/session──> shell (repo root, :3000)
                            │  proxies /api/* , injects CORE_TOKEN
                            ▼
                         core (core/, loopback 127.0.0.1:8787)
                            │  model routing, memory, tools, modules, scheduling
                            ▼
                         your model gateway (LiteLLM) + your Supabase
```

- **Shell** — the optional UI and a thin reverse proxy. It holds **no** AI logic
  and **no** model secrets.
- **Core** — the brain: a Bun/Hono backend built from source. Model routing,
  memory, the tool layer, modules, scheduling, autonomy.

## The shell holds no data

The shell renders the UI and forwards requests; it stores nothing of its own.
Your data lives in **your** Supabase project (or the bundled local Postgres) and
on **your** host. The single place the shell knows about the core is the
catch-all proxy at [`src/app/api/[...path]/route.ts`](../src/app/api/[...path]/route.ts):
it forwards every `/api/*` call verbatim to the core, and on the way it

- injects the `x-spectre-core-token` header (the browser never sees `CORE_TOKEN`),
- strips the session cookie and host before forwarding, and
- streams the response body straight through so chat SSE reaches the browser live.

The PIN is answered in the shell (`/api/auth/*`), so your PIN never reaches the
core.

## The core binds loopback behind CORE_TOKEN

The core listens on `127.0.0.1:8787` only and is never meant to be exposed on a
public interface. (In Docker the container binds `0.0.0.0` internally and the
compose mapping `127.0.0.1:8787:8787` enforces loopback exposure.)

Every `/api/*` request must carry the secret `CORE_TOKEN`. The gate is
fail-closed and lives in [`core/src/server/mw.ts`](../core/src/server/mw.ts):

- no token configured → `503`,
- wrong token → `401` (compared in constant time, so it isn't a timing oracle),
- `/api/health` is the only unauthenticated route.

So even if someone gets past the PIN, the core still won't answer without the
token — and you can read exactly how that gate works.

## Every tool call passes the permission broker

Tools (shell, files, calendar, schedules, screenshots, modules) run through the
MCP broker in [`core/spectre-mcp-broker/`](../core/spectre-mcp-broker/). Each
call passes an approval gate with saved permissions and quotas. On top of that,
a static command scanner ([`command-scan.mjs`](../core/spectre-mcp-broker/command-scan.mjs))
classifies shell commands as `block` / `flag` / `ok` *above* the human approval
gate:

- **block** — catastrophic/irreversible (e.g. raw writes to a block device);
  never run, not even with approval,
- **flag** — suspicious; always require interactive human approval, even in
  auto-approve mode, with the matched reason shown,
- **ok** — normal approval flow.

A daily spend cap cuts off paid models at your limit; local models run free.

## What the agent can and can't touch

- **Can:** run code and shell commands on the host on your behalf, read/write
  files, call its granted tools, and reach the providers and channels you
  configure. The core can execute code on the host — so treat the host, the PIN,
  and `CORE_TOKEN` as trusted-only.
- **Can't (without you):** run disk-wiping/irreversible commands (hard-blocked),
  exceed your spend cap on paid models, or act autonomously while autonomy is
  off (it's off by default). Modules get their own pinned storage, only the
  capabilities their manifest is granted, and outbound fetches via an allowlist
  that's logged.

## See also

- [`SECURITY.md`](../SECURITY.md) — reporting and the threat model in brief.
- [`core/README.md`](../core/README.md) — the core's own security notes.
- [`docs/MODULES.md`](MODULES.md) — the module sandbox and trust model in detail.
