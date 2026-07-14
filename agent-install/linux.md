# Linux Startup Playbook

Follow the global rules in `README.md`: official repo only, show commands first, confirm `sudo` and startup changes, stop on first error, and never print secrets.

## Goal

Make Spectre Agent come back after boot on Linux.

The Compose services already include `restart: unless-stopped`. Do not add process managers. Linux startup needs Docker enabled at boot and one Compose `up -d` run from the install directory.

## 1. Enable Docker On Boot

Ask the human before running this because it uses `sudo` and changes startup behavior:

```bash
sudo systemctl enable --now docker
```

Verify:

```bash
systemctl is-enabled docker
systemctl status docker
```

Expected: Docker is enabled and active.

If `docker info` fails with permission denied, the user is not in the Docker group. Ask before running:

```bash
sudo usermod -aG docker "$USER"
```

Then tell the human to log out and back in. Do not proceed in a shell where `docker info` still fails.

Rootless Docker caveat: if the human uses rootless Docker, do not use the system Docker service. Use their rootless Docker setup instead; if logout survival is required, they may need lingering enabled:

```bash
loginctl enable-linger "$USER"
```

Confirm before changing this.

## 2. Prefer The Wizard's Boot-Service Offer

The installer may offer to install a Linux systemd boot service during finishing touches. If the human accepted it, verify it instead of creating a duplicate unit:

```bash
systemctl is-enabled spectre.service
systemctl status spectre.service
```

If `spectre.service` exists and is enabled, use it.

## 3. Install A Systemd Unit If Needed

Only do this if the wizard did not install a boot service. Confirm with the human before creating the unit because this changes startup behavior.

Replace `/absolute/path/to/spectre-agent` with the actual install directory.

```ini
[Unit]
Description=Spectre Agent Docker Compose stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/absolute/path/to/spectre-agent
ExecStart=/usr/bin/docker compose --env-file .env.docker up -d
ExecStop=/usr/bin/docker compose --env-file .env.docker stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

Write it to:

```text
/etc/systemd/system/spectre.service
```

Then reload and enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spectre.service
```

Verify:

```bash
systemctl is-enabled spectre.service
systemctl status spectre.service
```

Expected: `enabled` and successful status.

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

Any HTTP response confirms the local endpoint is reachable. If services are unhealthy, inspect only the failing service logs and stop after the first clear error:

```bash
docker compose --env-file .env.docker logs --tail 80 SERVICE_NAME
```

## Notes

- Do not create container-specific systemd units. The Compose file already owns service restart policy.
- Do not run a bare `docker compose up`; use `--env-file .env.docker`.
- If the install is inside WSL2 while Docker Desktop runs on Windows, Docker startup is owned by Docker Desktop on Windows. Follow `windows.md` for Docker Desktop autostart and use Linux commands only inside the WSL shell.
