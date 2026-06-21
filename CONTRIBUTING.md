# Contributing

Thanks for your interest. Spectre is a self-hosted personal AI agent, fully open
source (MIT). Both halves live in this one repo: the **shell** (UI + proxy) at
the root, and the **core** (the brain) in [`core/`](core/).

## Architecture in one line

The shell (this repo root — the UI, port 3000) proxies `/api/*` to the core
(`core/`, a Bun/Hono backend on loopback `:8787`, gated by a `CORE_TOKEN`). The
shell holds **no** AI logic or secrets; it renders the UI and forwards requests.
The core does the model routing, memory, tools, modules, and scheduling. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

## Dev setup

**Shell** (repo root):

```bash
npm install
npm run dev      # http://localhost:3000
```

**Core** (`core/`) — a Bun/Hono backend, built from source:

```bash
cd core
npm install
npm run build
npm run start    # core API on 127.0.0.1:8787
```

The shell needs a running core for the API to respond. The simplest path for
both together is the Docker stack — see [`docs/M6-INSTALLER.md`](docs/M6-INSTALLER.md)
and `core/README.md`.

## Ground rules

- **Keep the boundary.** No model/provider logic, prompts, or secrets in the
  shell — those belong in the core. The shell talks to the core only through
  `@/lib/sdk` (`spectre.*`).
- **Follow the design system** (`DESIGN.md`): assemble the UI kit / tab schema,
  don't hand-roll chrome, and use the `:root` design tokens (never raw hex).
- Run `npm run build` before opening a PR; keep it type-clean.
- Report security issues privately (see `SECURITY.md`), never in a public issue.
