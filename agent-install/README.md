# Spectre Agent AI-CLI Install Playbook

This is the playbook an AI CLI follows to install Spectre Agent for a **non-technical
user, entirely through the chat window**. You ask plain-language questions in chat,
map the answers to installer flags, and run every command yourself. The human never
touches the terminal wizard.

## The golden rule

**Never hand the human a terminal wizard.** The installer has a fully unattended mode
(`--non-interactive`). You gather the choices in chat, then run:

```bash
node installer/install.mjs --non-interactive <flags>
```

The only thing you ask the human to run themselves is the **one-line PIN hash**
(below) — so you never see or invent their PIN.

## Rules

- Use only the official repo: `https://github.com/EliasT5/spectre-agent.git`. After cloning, run `git remote -v` and abort if any remote is not that URL.
- Show each command in chat before you run it, in plain language.
- Confirm with the human before anything using `sudo`/admin rights, anything destructive, or anything that changes boot/login startup items.
- Never print, store, invent, suggest, log, or repeat the PIN or any API key. Never print `.env.docker` (it holds `PIN_HASH` and secrets).
- Treat a `SPECTRE_FATAL:` line **or** a non-zero exit as the only real failures. These lines are **expected and NOT failures**: `pull access denied for spectre-core` (a locally-built image), `already present`, and a provider key marked `unverified`.
- Do not add `pm2`, `nohup`, `forever`, cron `@reboot`, reverse proxies, TLS, firewall changes, or port remapping — the installer's `--non-interactive` flags cover startup and tailnet HTTPS.

## Step 1 — Prerequisites (install the missing ones yourself)

Detect OS + architecture, then check `git`, Docker (with the Compose plugin **and a
running daemon**), and Node.js 20+. Verify the Docker **daemon** with `docker info`
(not just `docker --version` — the CLI answers even when the daemon is stopped).

**macOS** (Homebrew):

```bash
brew install git node
brew install --cask docker      # then open Docker Desktop once so the daemon starts
open -a Docker
```

**Windows** (winget, in PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Docker.DockerDesktop -e
# Then launch Docker Desktop once and wait for the whale icon to go steady.
```

**Debian/Ubuntu Linux**:

```bash
sudo apt-get update && sudo apt-get install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
# Docker Engine + compose plugin:
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # then have the user re-login so `docker` works without sudo
```

**Fedora/RHEL Linux**:

```bash
sudo dnf install -y git nodejs
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
```

If `docker info` fails after install, tell the human to start Docker Desktop (Mac/Windows)
or run `sudo systemctl start docker` (Linux), then continue. The installer also waits for
the daemon on its own.

## Step 2 — Clone + verify the repo

```bash
git clone https://github.com/EliasT5/spectre-agent.git
cd spectre-agent
git remote -v   # every line must be the official URL above, else abort
```

## Step 3 — Ask the human, in chat, plain language

Ask only what matters; use the defaults for the rest. Suggested questions and how each
maps to a flag:

| Ask in chat | Flag | Default if they don't care |
| --- | --- | --- |
| "Store everything on this machine, or use a cloud database?" | `--db=local` / `--db=cloud` | `--db=local` (recommended — cloud needs a manual SQL paste you can't automate) |
| "Just the app, or add the code Workspaces IDE? (or no web UI at all?)" | `--profile=standard` / `full` / `headless` | `--profile=standard` |
| "Run the AI on this machine for free (local), or use a provider like Anthropic/OpenAI with a key?" | `--brain=ollama:<model>` / `--brain=api:<model>` | `--brain=ollama:qwen2.5:7b-instruct --pull-model` |
| (if they picked a provider) "Paste your API key" — you set it as **env**, never a flag | env `SPECTRE_KEY_<PROVIDER>` | — |
| "Want to reach it from your phone later?" | (leave tailnet on; set up later) | tailnet HTTPS auto-enabled if Tailscale is present |

Then get the **PIN** without ever seeing it (next step).

## Step 4 — The PIN, without you seeing it

Ask the human to pick a PIN (≥6 digits, not a repeat/sequence), then have **them** run
this one-liner in their own terminal and paste back only the **hash** it prints:

```bash
node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(String(process.argv[1])).digest('hex')+'\n')" <THEIR-PIN>
```

You pass the pasted hash as `--pin-hash=<hash>`. You never learn the raw PIN.

## Step 5 — Run the unattended install yourself

Compose the flags from the answers and run it. Example (local DB, standard profile,
local brain, phone access off for now):

```bash
node installer/install.mjs --non-interactive \
  --db=local \
  --profile=standard \
  --brain=ollama:qwen2.5:7b-instruct --pull-model \
  --pin-hash=<hash-from-step-4>
```

Example with a hosted brain (key passed as env, never a flag):

```bash
SPECTRE_KEY_ANTHROPIC=<their-key> node installer/install.mjs --non-interactive \
  --db=local --profile=standard \
  --brain=api:anthropic/claude-sonnet-4-6 \
  --pin-hash=<hash>
```

Watch the output for `SPECTRE_STEP_OK:<name>` progress markers. Stop and report only on a
`SPECTRE_FATAL:` line or a non-zero exit — the installer's own verification gates
(containers Up, core + shell healthy, one real chat completion) run automatically and
turn any real problem into a `SPECTRE_FATAL:`.

### Full flag / env reference

Non-interactive trigger: `--non-interactive` (alias `--yes`, or env `SPECTRE_INSTALL_NONINTERACTIVE=1`).

- **Database:** `--db=local|cloud` (default `local`). Cloud also needs `--supabase-url=<url>` and `--supabase-service-key=<key>` (or env `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`). Cloud requires a **manual** one-time paste of `supabase/_apply_all.sql` in the Supabase SQL editor — prefer local for a hands-off install.
- **Profile:** `--profile=headless|standard|full` (default `standard`).
- **Brain:** `--brain=ollama:<model>` or `--brain=api:<model>` (default `ollama:<first installed model, else qwen2.5:7b-instruct>`). `--pull-model` pulls the Ollama model now. `--brain-key-env=<ENV>` names the env var holding an API brain's key (defaults to the provider's conventional var).
- **Day-to-day local models (optional):** `--learn-model=<model>`, `--embed-model=<model>`.
- **Provider API keys:** set as env `SPECTRE_KEY_<PROVIDER>` — `ANTHROPIC`, `OPENAI`, `GOOGLE`, `OPENROUTER`, `GROQ`, `MISTRAL`, `DEEPSEEK`, `XAI`, `TOGETHER`, `FIREWORKS`, `CEREBRAS`, `PERPLEXITY`, `HUGGINGFACE` (or the provider's own env var, e.g. `ANTHROPIC_API_KEY`). Never pass a key as a flag.
- **PIN:** `--pin-hash=<sha256 hex>` (or env `SPECTRE_PIN_HASH`). Required on a first install; a re-run keeps the existing PIN if omitted.
- **Networking:** `--shell-port=<n>` (default `3100`), `--bind=127.0.0.1|0.0.0.0` (default `127.0.0.1`; only use `0.0.0.0` behind HTTPS).
- **Channels:** `--telegram-token=`, `--telegram-allowed-ids=`, `--whatsapp-token=`, `--whatsapp-phone-id=`, `--whatsapp-app-secret=`, `--whatsapp-allowed-ids=`, `--discord-token=`, `--discord-allowed-ids=` (or the matching env vars). Webhook secrets are generated for you.
- **CLI subscription brains (optional, opt-in):** `--enable-claude-cli` (+ `--claude-oauth-token=` or env `CLAUDE_CODE_OAUTH_TOKEN`), `--enable-codex-cli`, `--enable-gemini-cli`. Enabling Claude/Codex bakes those CLIs into the core image (+~1GB); the default local/API path stays lean.
- **Workspaces (Full profile):** `--gh-token=<token>` (or env `GH_TOKEN`), `--trusted-dirs=<comma-sep absolute host paths>` (the first is mounted read/write for the IDE).
- **Post-install toggles:** `--no-tailscale` (skip tailnet HTTPS), `--no-boot-service` (skip the Linux/systemd boot service).

### Output markers

- `SPECTRE_STEP_OK:<name>` — a step finished (`docker-daemon`, `database`, `brain`, `configure`, `downloads`, `local-db`, `stack-up`, `containers-up`, `core-health`, `shell-health`, `chat-completion`, `done`).
- `SPECTRE_FATAL:<msg>` — a real, install-stopping failure. Report the message.
- `SPECTRE_SUMMARY:<key>=<value>` — the closing report (install dir, profile, brain, chat_ok, url, core_healthy).

## Step 6 — Close the loop (the assist)

On success the installer prints a `SPECTRE_SUMMARY:` block. Relay it to the human in
plain language:

- where it's installed, which profile, which brain, and **whether the real chat test passed** (`chat_ok=true`),
- the URL to open (`http://127.0.0.1:3100` for Standard/Full, or the core API for Headless),
- that they unlock it with the PIN they chose.

Then explicitly ask: **"Is anything still unclear?"** and answer their follow-ups in chat
— how to open it, how to reach it from a phone ([tailnet.md](./tailnet.md)), how to add a
messaging channel, or how updates work (below). Do not promise to recover or reveal the PIN.

## Remote access (phone + desktop)

Loopback (`http://127.0.0.1:3100`) works on the host only. To reach Spectre from a phone
or another computer, put it behind HTTPS on the private Tailscale network:
[tailnet.md](./tailnet.md). If Tailscale is already installed, the non-interactive
installer runs `tailscale serve` for you (unless you passed `--no-tailscale`). HTTPS is
required there — Spectre's session cookie is `Secure`, so plain HTTP loops the PIN screen.

## Update

Spectre self-updates. Three ways, easiest first.

**1. One-click, in the app (recommended for non-technical users).**
When a newer version is on GitHub, the web UI shows an **"Update available"** banner with an
**Update now** button (and **Settings → Updates** for config). The button rebuilds + restarts in
place — no terminal. It's powered by the `updater` sidecar (compose `update` profile), which the
installer enables automatically for UI (Standard/Full) installs.

Per-target control in **Settings → Updates** (Core and Shell, independent):
- **Core** — default **auto** (recommended): applied by the sidecar's 6-hourly check.
- **Shell** — default **ask**. Auto is available but warns that a shell update **overwrites the
  shell's committed files**. It does **NOT** touch your modules — separate-repo modules (e.g.
  `spectre-lingua`), `/data` extensions (skills/tools/mcp), or uncommitted local changes (the
  updater refuses to run on a dirty tree).
- Each is Ask / Auto / Off, and can be muted for a while.

**2. The update script (CLI, headless, or when the shell is down).** From the install directory:

```bash
node scripts/spectre-update.mjs --check                 # behind origin/main? (exit 10 = yes)
node scripts/spectre-update.mjs --apply                 # update core + shell
node scripts/spectre-update.mjs --apply --target core   # core only  (or --target shell)
node scripts/spectre-update.mjs --auto                  # apply only targets set to "auto" (for a host cron)
```

It pulls `--ff-only`, rebuilds **baking the git SHA in** (`SPECTRE_BUILD_SHA` — so version detection
works), recreates the target services (a core update also recreates the chat/scheduler/channel
runners that share the core image), health-checks the core, and prints rollback steps on failure.
`scripts/spectre-update.sh` is a curl-able bootstrap wrapper.

**3. Manual (always works):**

```bash
git pull
docker compose --env-file .env.docker up -d --build
```

### How it works — read this so we don't trip on it later

- **Version detection** (`GET /api/update/status`): the core image is stamped with the git SHA it
  was built from (`SPECTRE_BUILD_SHA`), and compares it to the latest commit on `origin/main` via the
  GitHub API. Two gotchas:
  - **The repo is private → detection needs the GitHub token set in Settings.** No token ⇒ "no
    update" with a note, never an error.
  - **A bare `docker compose build` bakes NO SHA** ⇒ detection reports "unknown" until the next
    installer/update-script rebuild stamps it in. The installer and `spectre-update.mjs` always pass it.
- **The `updater` sidecar** (`updater-service/`) mounts the **host Docker socket**
  (host-root-equivalent) so it can rebuild the stack — a container can't rebuild itself. It is
  **internal-only, `UPDATER_TOKEN`-gated, and opt-in** via the `update` compose profile (auto-added
  for UI installs; headless installs skip it and use the script/manual path). If the profile is off,
  the "Update now" button falls back to showing the script command.
- **Reminders** (Settings → Updates): the background check opens a chat where a local Ollama model
  asks whether to update (per active target) + raises a Monitor event. Muted/off targets stay quiet.
