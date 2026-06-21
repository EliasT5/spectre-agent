# M2 — Dockerized core (self-hostable)

The whole brain runs from one image as a small set of always-on processes.

```
docker compose up
 ├─ core         node server.js            (Next standalone API, :8787 → host 127.0.0.1:8787)
 ├─ chat-runner  node worker/chat-runner   (durable chat executor)
 └─ scheduler    node worker/scheduler     (nightly maintenance + routines)
   (+ worker     node worker/worker        — `--profile self-evolve`, edits a mounted target repo)
```

## How the hard parts are solved

- **CLI auth without a keychain mount.** The image installs the
  `claude` CLI and authenticates **headlessly** via `CLAUDE_CODE_OAUTH_TOKEN`.
  The user runs `claude setup-token` once on the host (browser OAuth, uses their
  own subscription) and pastes the token into `.env.docker`. No `~/.claude`
  mount, no OS-keychain dependency — portable across Win/Mac/Linux.
- **Ollama on the host.** Embeddings + the local learn/distill models live on
  the host's Ollama; the container reaches it at `host.docker.internal:11434`
  (compose adds `host-gateway` for Linux). No model weights in the image.
- **Supabase** is network (the user's project) — nothing to containerize.
- **The MCP broker's zod v3** is installed in-image (`npm ci` in
  `spectre-mcp-broker/`) so it doesn't fall back to the app's zod v4.
- **Loopback only.** The host port binds `127.0.0.1:8787` — the shell is the
  only front door; the core is never exposed beyond loopback.

## Run

```bash
cp .env.docker.example .env.docker     # fill in: CORE_TOKEN, Supabase keys,
claude setup-token                     # → paste the token into CLAUDE_CODE_OAUTH_TOKEN
docker compose up --build              # core + chat-runner + scheduler
# self-evolution (optional): point at the shell/modules repo, never the core
SPECTRE_TARGET_REPO=/abs/modules docker compose --profile self-evolve up
```

## Verified (2026-06-02)

- Image builds clean (`next build` passes; broker zod v3 installed; claude CLI +
  git in the runtime).
- Container boots and serves `GET /api/health` → 200 with `coreApiVersion`.
- Chat in-container requires `CLAUDE_CODE_OAUTH_TOKEN` (host `claude setup-token`)
  — that's the one human step; everything else is automatic.

## Deferred

- **Installer wizard** (M6): wraps this stack — detect CLIs, collect creds,
  `claude setup-token`, Tailscale links, PIN, `docker compose up`. The compose
  stack here is the substrate it drives.
- Bundling Ollama + a local Supabase in-stack (currently host Ollama + hosted
  Supabase).
