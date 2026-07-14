# macOS Startup Playbook

Follow the global rules in `README.md`: official repo only, show commands first, confirm startup changes, stop on first error, and never print secrets.

## Goal

Make Spectre Agent come back when the human signs in on macOS.

Docker Desktop on macOS is login-scoped, not true unattended boot. Spectre starts after the user logs in, Docker Desktop starts, and the LaunchAgent runs Compose from the install directory.

## 1. Enable Docker Desktop Autostart

Ask the human to open Docker Desktop settings and enable:

```text
Start Docker Desktop when you sign in
```

Then verify Docker is running:

```bash
docker info
```

Verify Compose exists:

```bash
docker compose version
```

## 2. Create A LaunchAgent

Confirm with the human before creating or changing a login startup item.

Replace `/absolute/path/to/spectre-agent` with the actual install directory.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.elias-teubner.spectre-agent</string>

    <key>WorkingDirectory</key>
    <string>/absolute/path/to/spectre-agent</string>

    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/docker</string>
      <string>compose</string>
      <string>--env-file</string>
      <string>.env.docker</string>
      <string>up</string>
      <string>-d</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/spectre-agent-launchd.out.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/spectre-agent-launchd.err.log</string>
  </dict>
</plist>
```

If Docker is installed somewhere else, find the path first:

```bash
command -v docker
```

Save the plist as:

```text
~/Library/LaunchAgents/dev.elias-teubner.spectre-agent.plist
```

Load it:

```bash
launchctl load "$HOME/Library/LaunchAgents/dev.elias-teubner.spectre-agent.plist"
```

Verify it is registered:

```bash
launchctl list | grep dev.elias-teubner.spectre-agent
```

## 3. Start The Stack Once

From the install directory:

```bash
docker compose --env-file .env.docker up -d
```

First start may take several minutes while images build or pull. Do not interrupt it.

## 4. Verify Spectre

From the install directory:

```bash
docker compose --env-file .env.docker ps
```

For Standard or Full profiles, check:

```bash
curl -I http://127.0.0.1:3100
```

For Headless, check:

```bash
curl -I http://127.0.0.1:8787
```

If services are unhealthy, inspect only the failing service logs and stop after the first clear error:

```bash
docker compose --env-file .env.docker logs --tail 80 SERVICE_NAME
```

## Notes

- This is login startup, not raw boot startup.
- Do not add `pm2`, `nohup`, cron, or a separate process manager.
- Do not run a bare `docker compose up`; use `--env-file .env.docker`.
- If `launchctl load` says the service is already loaded, unload it before reloading only after confirming with the human.
