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

   Brief the human first: the wizard asks which database to use, which model path to use, which profile to install, and which PIN to set. Bundled local Postgres, local Ollama, and the Standard profile are normal defaults. The raw PIN is never stored; only `PIN_HASH` is written to `.env.docker`.

5. Set up always-on startup using the matching OS file:

   - [Linux](./linux.md)
   - [macOS](./macos.md)
   - [Windows](./windows.md)

6. Verify the stack:

   ```bash
   docker compose --env-file .env.docker ps
   ```

7. Report the install directory, chosen profile if known, startup mechanism, and the correct local URL.

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
