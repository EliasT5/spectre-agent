# Windows Startup Playbook

Follow the global rules in `README.md`: official repo only, show commands first, confirm admin or startup changes, stop on first error, and never print secrets.

## Goal

Make Spectre Agent come back when the human signs in on Windows.

Docker Desktop on Windows is login-scoped, not true unattended boot. Spectre starts after the user logs in, Docker Desktop starts, and the Scheduled Task runs Compose from the install directory.

## 1. Enable Docker Desktop Autostart

Ask the human to open Docker Desktop settings and enable:

```text
Start Docker Desktop when you sign in
```

Then verify Docker is running:

```powershell
docker info
```

Verify Compose exists:

```powershell
docker compose version
```

If Docker uses WSL2, WSL must also be available when the user signs in:

```powershell
wsl --status
```

If WSL2 is missing, `wsl --install` requires admin rights and may require a reboot. Confirm with the human before any admin action.

## 2. Create A Logon Scheduled Task

Confirm with the human before creating or changing a startup task.

Replace `C:\Users\NAME\spectre-agent` with the actual install directory.

```powershell
schtasks /Create /TN "Spectre Agent" /SC ONLOGON /TR "cmd /c cd /d C:\Users\NAME\spectre-agent && docker compose --env-file .env.docker up -d" /F
```

Verify the task exists:

```powershell
schtasks /Query /TN "Spectre Agent"
```

Optional PowerShell equivalent:

```powershell
$Action = New-ScheduledTaskAction -Execute "docker.exe" -Argument "compose --env-file .env.docker up -d" -WorkingDirectory "C:\Users\NAME\spectre-agent"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Spectre Agent" -Action $Action -Trigger $Trigger -Description "Start Spectre Agent Docker Compose stack at logon" -Force
```

## 3. Start The Stack Once

From the install directory:

```powershell
docker compose --env-file .env.docker up -d
```

First start may take several minutes while images build or pull. Do not interrupt it.

## 4. Verify Spectre

From the install directory:

```powershell
docker compose --env-file .env.docker ps
```

For Standard or Full profiles, check:

```powershell
curl.exe -I http://127.0.0.1:3100
```

For Headless, check:

```powershell
curl.exe -I http://127.0.0.1:8787
```

If services are unhealthy, inspect only the failing service logs and stop after the first clear error:

```powershell
docker compose --env-file .env.docker logs --tail 80 SERVICE_NAME
```

## Notes

- This is login startup, not raw boot startup.
- Docker Desktop must start at login for the task to work.
- If Docker runs inside WSL instead of Docker Desktop, the WSL distro must start too.
- Do not add `pm2`, `nohup`, cron, or a separate process manager.
- Do not run a bare `docker compose up`; use `--env-file .env.docker`.
