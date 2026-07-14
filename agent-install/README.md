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

From the install directory:

```bash
git pull
docker compose --env-file .env.docker up -d --build
```
