# Installer (Docker, cross-platform)

Bring up the whole Spectre stack on your own machine, on **your own models** — a
local Ollama model with zero API keys, or your own API keys via the bundled
gateway. The **shell** and the **core** are both built locally from this repo (the
core lives in [`core/`](../core/) and compiles from source). They talk over a
private Docker network; only the shell is exposed.

```
  you ──▶ shell (:3100, this repo) ──/api proxy──▶ core (:8787 loopback, built from ./core)
                                                    ├─ litellm  (:4000, model gateway)
                                                    ├─ chat-runner (durable chat)
                                                    └─ scheduler   (nightly maint)
```

## The brain — provider-agnostic

Spectre's brain runs against a **LiteLLM gateway** (the `litellm` service, bundled
in the compose). You point it at whatever you want:

- **Local & free (default):** a local **Ollama** model — zero API keys, fully
  offline. The installer defaults `SPECTRE_LITELLM_MODEL=spectre-default` (Ollama).
- **Your own API keys:** Anthropic / OpenAI / Gemini / Azure / Bedrock — uncomment
  the model in `litellm-config.yaml` and give the key. These are metered API keys,
  not subscriptions.

> **Subscription CLIs are off by default.** The installer's default is the API-key
> gateway (metered, portable). Claude Code CLI is an opt-in that uses your own
> Claude subscription -- see the Claude CLI section below.

## Prerequisites

| Need | Why | Get it |
|---|---|---|
| **Docker** + Compose v2 | runs the stack | **Linux:** Docker Engine + compose plugin — <https://docs.docker.com/engine/install/> · **macOS / Windows:** Docker Desktop — <https://www.docker.com/products/docker-desktop/> |
| **core** | the brain (built from `core/`) | compiled by `docker compose up --build` — nothing to pull |
| **Supabase** *(optional — local is default)* | storage (chat, memory, config) | nothing to do for **local** (bundled); for **cloud** copy URL + anon + service-role from <https://supabase.com> |
| **Ollama** *(recommended)* | the free local brain + embeddings | <https://ollama.com> → `ollama pull qwen2.5:7b-instruct nomic-embed-text` |
| Provider API key *(optional)* | a hosted model via the gateway | Anthropic / OpenAI / Gemini console |

### Platform notes

Runs on **Windows, macOS, and Linux** — the installer is pure Node and the stack
is Docker Compose. A few per-OS specifics the installer also reminds you about at
runtime:

- **Windows** — run `node installer/install.mjs` from a real terminal (PowerShell
  or Git Bash); Docker Desktop with the WSL2 backend provides `host.docker.internal`
  and reaches host Ollama out of the box. The Workspaces *trusted-folder* mode is
  Linux/macOS-only — use sandbox clones on Windows.
- **macOS** — Docker Desktop. On **Apple Silicon** the core image is multi-arch
  (linux/arm64), so it runs natively once published that way; until then it
  emulates under Rosetta (enable Docker Desktop → *Use Rosetta for x86/amd64*).
- **Linux** — Docker **Engine** + the compose plugin (not Docker Desktop). If you
  use the local Ollama brain, bind it to `0.0.0.0` so containers can reach it via
  `host.docker.internal`: `sudo systemctl edit ollama` → `Environment="OLLAMA_HOST=0.0.0.0:11434"`
  → restart. (The default `127.0.0.1` bind is unreachable from a container.)

## Install (the wizard)

```bash
node installer/install.mjs              # detect → collect → write → up → links
```

The wizard:
1. Detects Docker + `ollama`/`tailscale` (+ any provider CLIs) and prints versions.
2. Collects your Supabase URL + anon + service-role key; **optional** provider API
   keys for the gateway; your local Ollama models; and a **PIN** (≥6 non-trivial
   digits, hashed SHA-256 — the raw PIN is never stored).
3. Generates `CORE_TOKEN`, `SESSION_SECRET`, `LITELLM_MASTER_KEY`,
   `SPECTRE_SERVICE_TOKEN`; writes `.env.docker` (gitignored, mode 600).
4. Runs `docker compose up -d --build` and health-checks `http://127.0.0.1:8787/api/health`.
5. Prints your **loopback** link and, if Tailscale is up, your **tailnet** link.
6. On Linux, offers a **systemd boot service** (`spectre.service`) so the stack
   returns after a reboot — Docker's restart policy alone won't re-`up` a stack
   that was `down` at shutdown. Then it helps you finish any **channels / Tailscale**
   you skipped: the installed AI guide walks you through it, or it points you at
   the in-repo guides (`.env.docker.example` for channels, this file for Tailscale).

**Re-running** on a machine that already has Spectre opens a **manage menu** —
update the core image, rebuild the shell, reconfigure, or uninstall — instead of
redoing first-time setup. The boot service makes restarts safe; updates land via
the menu, the one-line installer, or the in-app update banner.

## Database — local (default) or cloud

The wizard asks **[L]ocal** or **[C]loud** (Local is the default — no account, no keys).

- **Local (self-hosted):** brings up a *trimmed* Supabase as a **separate compose
  project** (`local-db/docker-compose.yml`): Postgres + pgvector, **PostgREST**
  (the `/rest/v1` data plane the core's `supabase-js` RPCs need — e.g.
  `match_memory`, `match_pdf_chunks`, `match_generated_media`), **Realtime** (durable
  chat's `postgres_changes`), and **Kong** on `127.0.0.1:8000`. GoTrue/Storage/Studio
  are intentionally dropped — Spectre auths with `CORE_TOKEN`, not Supabase Auth.
  The installer generates the HS256 anon/service JWTs (`gen-supabase-keys.mjs`),
  waits for the roles, creates the `supabase_realtime` publication, and **applies
  `supabase/_apply_all.sql`** (idempotent; kept byte-identical to the core via the
  schema generator, so a local DB gets the *full* schema — including the
  `generated_media` recall table). Wiring: containers use
  `SUPABASE_URL=http://host.docker.internal:8000` (the core/worker services carry
  `extra_hosts: host.docker.internal:host-gateway` so this resolves on Linux); the
  browser uses `NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000`.
- **Cloud:** paste your project URL + anon + service-role key; apply
  `supabase/_apply_all.sql` once via the Supabase SQL editor.

### CLI tool brains (optional)

The wizard presents all three subscription CLIs as optional brains -- default
**no** for each. All three are off by default; the standard LiteLLM gateway
brain doesn't need any of them.

| CLI | Gate env | Login | Token capture |
|---|---|---|---|
| **Claude Code** (`claude`) | `SPECTRE_ALLOW_CLAUDE_CLI=1` | `claude setup-token` | yes -- `CLAUDE_CODE_OAUTH_TOKEN` (portable into the container) |
| **Codex CLI** (`codex`) | `SPECTRE_ALLOW_CODEX_CLI=1` | `codex login` | no -- host-only OAuth; the container uses `OPENAI_API_KEY` |
| **Gemini CLI** (`gemini`) | `SPECTRE_ALLOW_GEMINI_CLI=1` | `gemini` | no -- host-only OAuth; the container uses `GOOGLE_GENAI_API_KEY` |

Enabling any of the three only sets its gate flag (`SPECTRE_ALLOW_*_CLI=1`) -- no
special core build is needed. The CLI then runs on your own subscription.

Each uses your own subscription with that vendor. Off by default -- a sensible
default for a provider-agnostic installer, not a restriction.

### Guided (conversational) install

If **Ollama** is running with a chat model, the wizard offers a guided mode: a
**local model narrates each step** and answers questions — type **`?your question`**
at any prompt. Purely advisory, entirely local. `--no-guide` to skip.

```bash
node installer/install.mjs --dry-run    # detection + the .env plan, no writes, no docker
node installer/install.mjs --check      # just the environment report
```

## Install (by hand, no wizard)

```bash
cp .env.docker.example .env.docker      # fill in every value
# PIN_HASH:  node -e "console.log(require('crypto').createHash('sha256').update('YOURPIN').digest('hex'))"
# secrets:   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # x CORE_TOKEN, SESSION_SECRET, LITELLM_MASTER_KEY, SPECTRE_SERVICE_TOKEN
docker compose up -d --build            # builds shell + core
```

## Networking & the PIN cookie

The shell binds **loopback by default** (`SHELL_BIND=127.0.0.1`). `localhost` is a
secure context, so the `Secure` session cookie sets and PIN login works at
`http://127.0.0.1:3100`.

To reach it from your **phone over the tailnet**, do NOT just set `SHELL_BIND=0.0.0.0`
over plain HTTP — browsers drop the `Secure` cookie on a non-localhost HTTP origin
and login bounces. Put it behind HTTPS:

```bash
tailscale serve --bg https / http://127.0.0.1:3100
```

(The installer requires an explicit confirmation before binding beyond localhost.)

## Tailscale (remote access over HTTPS)

To reach Spectre from your phone (or any device on your tailnet) you need HTTPS --
the `spectre_session` cookie carries the `Secure` flag, so browsers silently drop it
over plain HTTP on a non-localhost hostname and PIN login loops forever.

**Setup:**
1. Install Tailscale on the host machine and on your phone -- <https://tailscale.com/download>
2. On the host: `tailscale up` (authenticate + join your tailnet)
3. The installer detects Tailscale and offers to run:
   ```
   tailscale serve --bg https / http://127.0.0.1:<port>
   ```
   This puts the shell at `https://<host>.<tailnet>.ts.net` with real HTTPS via
   Tailscale's built-in cert authority -- no Caddy, no certbot, no firewall holes.

**Manual fallback** (if the installer's serve step fails):
```bash
tailscale up
tailscale serve --bg https / http://127.0.0.1:3100
```

The loopback URL (`http://127.0.0.1:3100`) stays the default for local use --
HTTPS is only needed when accessing from another device.

## Choosing models

The wizard lists the **Ollama models you actually have** and lets you pick the
day-to-day models (chat/learn for dream + distill, embeddings for memory), written
to `.env.docker`. The agentic brain model is `SPECTRE_LITELLM_MODEL` (a name from
`litellm-config.yaml`); the default `spectre-default` maps to your local Ollama.

## Migrating from Hermes / OpenClaw

```bash
node installer/import-configs.mjs --dry-run   # detect + show what it found
node installer/import-configs.mjs             # ask per-source, then import
```

It knows the on-disk layouts (Hermes `~/.hermes/`, OpenClaw `~/.openclaw/`) and
imports **provider keys** (merged into `.env.docker` only where blank),
**persona/identity/memory** markdown (staged under `installer/imported/<source>/`),
and **channel tokens** (staged to `carried.env`). History DBs are flagged, not
copied (re-index rather than copy raw embeddings).

## Self-evolution (optional)

Spectre can edit the shell/modules on a branch (never the core — the worker refuses
the core path):

```bash
# in .env.docker:  SPECTRE_TARGET_REPO=/abs/path/to/your/modules-repo
docker compose --profile self-evolve up -d
```

## Workspaces (optional)

In-browser code workspaces with **code-server (VS Code)** as the editor —
sandbox repo clones (→ commit → PR → close) and/or **trusted** local folders
(edited in place → push). Runs untrusted repo code, so it's OFF by default and
reachable only through the PIN-gated shell.

```bash
docker compose --profile ui --profile workspace up -d
```

This starts three extra services: `workspace` (the file/diff/shell/test API),
`code-server` (the VS Code editor, sharing the workspaces volume), and `edge` (a
Caddy reverse proxy). The editor is embedded in the Workspaces tab as an iframe,
which **must be same-origin** — code-server speaks WebSockets (a Next route can't
proxy them) and the shell's session cookie is `Secure`. So the `edge` serves both
the shell and `/code` (→ code-server) on one origin:

- Access Spectre via the **edge** — default **http://127.0.0.1:8090** (`EDGE_PORT`)
  — to use the editor. The plain shell port (`:3100`) still works for everything
  except the embedded editor.
- **HTTPS / tailnet:** set `SPECTRE_SITE_ADDRESS` to your domain and publish
  80/443 — Caddy does automatic TLS (which also satisfies the Secure-cookie
  requirement for remote access). See `deploy/Caddyfile`.
- `NEXT_PUBLIC_CODE_SERVER_URL` (build-time, default `/code`) controls where the
  tab loads the editor; for a quick localhost-only setup, build with
  `http://localhost:8088` (the direct code-server port) instead of running the edge.

**Know what this profile is:** the editor + workspace shell are file edit and
terminal execution on every mounted folder — i.e. code execution on those host
paths for anyone who gets past the gates. Defense in depth (beyond the shell
PIN): code-server requires its **own password** (`CODE_SERVER_PASSWORD`, the
installer generates one and prints it at the end; it's in `.env.docker`), both
containers run with all Linux capabilities dropped + `no-new-privileges`, and
the workspace API runs as a non-root user. Keep `CODE_SERVER_BIND`/`EDGE_BIND`
on loopback unless HTTPS is in front. `CODE_SERVER_AUTH=none` opts back out of
the editor password if you accept PIN-only protection.

> Validate the editor on a live Linux Docker host: bring up the profile, open the
> Workspaces tab via the edge, clone a repo, and confirm VS Code loads in the
> Editor tab (terminal + git diff + test-running are built in). The **Files** tab
> works without the editor.

## Packaging

The core compiles to standalone binaries with `bun build --compile` (see
`core/scripts/build.mjs`) for a lean runtime image — but the full source lives in
this repo at `core/` and the image is **built from it**. Nothing is pulled,
nothing is sealed; you can read and rebuild every part.

## Troubleshooting

| Symptom | Fix |
|---|---|
| core build fails | `docker compose build core` and read the output; the core compiles from `core/` |
| login bounces to `/pin` over the tailnet | use HTTPS (`tailscale serve`) — see Networking |
| `/api/health` never green | `docker compose logs core`; verify Supabase keys + that the schema was applied |
| chat replies are slow / time out on a local model | local Ollama on CPU is slow — point `SPECTRE_LITELLM_MODEL`/the gateway at a faster model or an API key |
| no embeddings / dream | start Ollama on the host + `ollama pull nomic-embed-text` |
| chat enqueues but never fills | `docker compose logs chat-runner`; confirm `SUPABASE_SERVICE_ROLE_KEY` |
| rebuild shell after editing UI | `docker compose up -d --build shell` |
