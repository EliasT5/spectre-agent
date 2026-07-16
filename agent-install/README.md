# Spectre Agent AI-CLI Install Playbook

This is the playbook an AI CLI follows to install Spectre Agent from the official repository.

## Rules

- Use only the official repo: `https://github.com/EliasT5/spectre-agent.git`.
- After cloning, run `git remote -v`; abort if every remote URL is not the official repo URL.
- Show each command before running it.
- Confirm with the human before anything using `sudo` or admin rights, anything destructive, or anything that changes boot/login startup items.
- Stop on the first error. Report the command and exact error. Do not continue with guessed workarounds.
- Never print, store, invent, suggest, log, or repeat the PIN or API keys.
- Never print `.env.docker`; it contains `PIN_HASH` and may contain secrets.
- The installer wizard is interactive. Hand the terminal to the human. Do not answer for them, pipe input, use `expect`, or invent a PIN.
- Do not add `pm2`, `nohup`, `forever`, cron `@reboot`, reverse proxies, TLS, firewall changes, or port remapping.
- The Compose services already use `restart: unless-stopped`; autostart only requires Docker to start and the stack to have been started once from the install directory.

## Steps

1. Detect OS and architecture.
2. Check for prerequisites and offer to install missing ones: `git`, Docker with the Compose plugin and running daemon, and Node.js 20+.
3. Clone the official repo, then verify it:

   ```bash
   git remote -v
   ```

   Expected remote URL:

   ```text
   https://github.com/EliasT5/spectre-agent.git
   ```

4. From the repo root, run the interactive wizard and hand the terminal to the human:

   ```bash
   node installer/install.mjs
   ```

   Brief the human first: the wizard asks which database to use, which **brain model** to use, which profile to install, and which PIN to set. Bundled local Postgres, local Ollama, and the Standard profile are normal defaults. The raw PIN is never stored; only `PIN_HASH` is written to `.env.docker`.

   **Choosing + testing a brain model** (this is what makes chat work out of the box): at the brain-model step the wizard offers a local Ollama model (recommended, no keys) or an API model (bring a key). If the human has no suitable local model, the wizard offers to **pull a small capable one** (e.g. `qwen2.5:7b-instruct`, or the lighter `llama3.2:3b`) and waits for it. It then wires the choice into `spectre-default` and **runs a quick test** — a one-token ping at the local Ollama daemon, or a key-auth check for an API provider — and reports pass or fail. If the test fails, the wizard prints the fix (usually `ollama pull <model>`); the human can also change the model later in **Settings → Providers**. The default brain is always a gateway-backed model, never a subscription CLI, so chat never lands on an unconfigured CLI. Do not paste a model choice for the human — hand them the terminal.

5. Set up always-on startup using the matching OS file:

   - [Linux](./linux.md)
   - [macOS](./macos.md)
   - [Windows](./windows.md)

6. Verify the stack:

   ```bash
   docker compose --env-file .env.docker ps
   ```

7. (Optional) Set up remote access from a phone or another computer over the tailnet: [tailnet.md](./tailnet.md). HTTPS is required there or PIN login loops.

8. Report the install directory, chosen profile if known, the brain model chosen (and whether its test passed) if known, startup mechanism, and the correct local URL.

## Verify

For Standard or Full profiles, open:

```text
http://127.0.0.1:3100
```

For Headless, verify the core:

```text
http://127.0.0.1:8787
```

The human signs in with the PIN they typed during the wizard. Do not promise to recover or report it.

## Remote access (phone + desktop)

Loopback (`http://127.0.0.1:3100`) works on the host machine only. To reach Spectre from a phone or another computer, put it behind HTTPS on your private Tailscale network: [tailnet.md](./tailnet.md).

HTTPS is not optional there — Spectre's session cookie is `Secure`, so browsers drop it over plain HTTP on any non-`localhost` hostname and PIN login loops. `tailscale serve` provides the HTTPS front door (tailnet-only, no public exposure). Confirm with the human before `sudo tailscale up`, and never enter or print the PIN.

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
