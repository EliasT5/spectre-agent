#Requires -Version 5.1
<#
  Spectre - one-line installer bootstrap (Windows / PowerShell).

    irm https://YOUR-SITE/install.ps1 | iex

  Prefer to read it first? Download, inspect, then run:
    irm https://YOUR-SITE/install.ps1 -OutFile install.ps1
    notepad install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Checks prerequisites, fetches the Spectre shell, and hands off to the
  interactive setup wizard (installer\install.mjs). Writes nothing outside the
  install directory. Override defaults with environment variables:
    SPECTRE_REPO     git URL of the public shell   (default below)
    SPECTRE_VERSION  tag or branch to check out     (default: main)
    SPECTRE_DIR      where to install               (default: %USERPROFILE%\spectre)
#>
$ErrorActionPreference = 'Stop'

$Repo    = if ($env:SPECTRE_REPO)    { $env:SPECTRE_REPO }    else { 'https://github.com/EliasT5/spectre-agent.git' }
$Version = if ($env:SPECTRE_VERSION) { $env:SPECTRE_VERSION } else { 'main' }
$Dir     = if ($env:SPECTRE_DIR)     { $env:SPECTRE_DIR }     else { Join-Path $HOME 'spectre' }
$MinNodeMajor = 20

function Say  ($m) { Write-Host "  ==> $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "   +  $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "   !  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "   x  $m" -ForegroundColor Red; throw 'Spectre install aborted.' }
function Have ($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# ---- banner -----------------------------------------------------------------
#
# Block char built at runtime so the source file stays ASCII-only.
# irm | iex on PS 5.1 reads the file as ANSI (Latin-1) when there is no BOM;
# any literal byte above 0x7E would render as mojibake.
#
$e  = [char]27          # ESC
$FB = [string][char]0x2588   # full-block char
$MD = [string][char]0xB7     # middle dot

# Banner rows as ASCII '#'-templates; rendered by replacing '#' with $FB.
$BannerRows = @(
  @{ Code = 135; Tmpl = ' ####### ######  #######  ###### ######## ######  #######' }
  @{ Code = 141; Tmpl = ' ##      ##   ## ##      ##         ##    ##   ## ##' }
  @{ Code = 147; Tmpl = ' ####### ######  #####   ##         ##    ######  #####' }
  @{ Code = 177; Tmpl = '      ## ##      ##      ##         ##    ##   ## ##' }
  @{ Code = 183; Tmpl = ' ####### ##      #######  ######    ##    ##   ## #######' }
)

$useVT = $Host.UI.SupportsVirtualTerminal -or
         ($null -ne $env:WT_SESSION -and $env:WT_SESSION -ne '')

if ($useVT) {
  Write-Host ""
  foreach ($row in $BannerRows) {
    $line = $row.Tmpl -replace '#', $FB
    Write-Host "$e[38;5;$($row.Code)m${line}$e[0m"
  }
  Write-Host ""
  Write-Host "$e[3m  It's your assistant. Haunt your own machine.$e[0m"
  Write-Host "$e[2m  self-hosted ${MD} any model ${MD} governed autonomy$e[0m"
  Write-Host ""
} else {
  foreach ($row in $BannerRows) {
    $line = $row.Tmpl -replace '#', $FB
    Write-Host $line -ForegroundColor Magenta
  }
  Write-Host ""
  Write-Host "  It's your assistant. Haunt your own machine."
  Write-Host "  self-hosted - any model - governed autonomy"
  Write-Host ""
}

# ---- OS check ---------------------------------------------------------------
if ($env:OS -ne 'Windows_NT') {
  Die 'This is the Windows installer. On macOS/Linux use:  curl -fsSL https://YOUR-SITE/install.sh | sh'
}

# ---- prerequisite detection -------------------------------------------------
$missing = @()
foreach ($c in 'git','docker') { if (-not (Have $c)) { $missing += $c } }

# node: missing OR too old
if (-not (Have 'node')) {
  $missing += 'node'
} else {
  $nodeMajorCheck = 0
  try { $nodeMajorCheck = [int]((node -v).TrimStart('v').Split('.')[0]) } catch {}
  if ($nodeMajorCheck -lt $MinNodeMajor) { $missing += 'node' }
}

if ($missing.Count -gt 0) {
  Warn ("Missing prerequisites: {0}" -f ($missing -join ' '))

  # Require winget
  if (-not (Have 'winget')) {
    $missingList = $missing -join ' '
    Die ("Missing prerequisites: $missingList - install them manually, then re-run.`n" +
         "  git:    https://git-scm.com/download/win`n" +
         "  node:   https://nodejs.org/`n" +
         "  docker: https://www.docker.com/products/docker-desktop")
  }

  $consent = Read-Host "  ? Install missing prerequisites via winget? [Y/n]"
  if ($consent -ne '' -and $consent -notmatch '^[Yy]') {
    Die ("Missing prerequisites: {0} - install them, then re-run." -f ($missing -join ' '))
  }

  foreach ($pkg in $missing) {
    switch ($pkg) {
      'git' {
        Say 'Installing git via winget...'
        winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
      }
      'node' {
        if (Have 'node') {
          Say 'Upgrading Node.js via winget...'
          winget upgrade --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        } else {
          Say 'Installing Node.js LTS via winget...'
          winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        }
      }
      'docker' {
        Say 'Installing Docker Desktop via winget...'
        winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements
      }
    }
  }

  # Refresh PATH in-session
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')

  # Re-verify
  $stillMissing = @()
  foreach ($c in $missing) { if (-not (Have $c)) { $stillMissing += $c } }
  if ($stillMissing.Count -gt 0) {
    $stillList = $stillMissing -join ' '
    Die "Installed but not on PATH: $stillList - open a new terminal and re-run."
  }
  Ok 'Prerequisites installed.'
}

# ---- docker running check ---------------------------------------------------
# IMPORTANT: never use stream-redirection (*> $null / 2>$null) on native exe
# calls under ErrorActionPreference=Stop. PS 5.1 turns redirected native stderr
# into a terminating error, causing the installer to crash before the
# Docker-Desktop launch/poll logic can run.
# Use the cmd.exe pass-through pattern instead: cmd /c "... >nul 2>&1"

cmd /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  # Docker is installed but not running. Try to launch Docker Desktop.
  $ddExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $ddExe) {
    Say 'Starting Docker Desktop...'
    Start-Process $ddExe
    Say 'Waiting for Docker to start (up to 120 s)...'
    $dockerReady = $false
    $attempts = 0
    while ($attempts -lt 24) {
      Start-Sleep -Seconds 5
      cmd /c "docker info >nul 2>&1"
      if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
      $attempts++
      Say "  still waiting... ($($attempts * 5) s elapsed)"
    }
    if (-not $dockerReady) {
      Die 'Docker Desktop did not start in time. Launch it manually and re-run.'
    }
    Ok 'Docker Desktop is running.'
  } else {
    Die 'Docker is installed but not running. Start Docker Desktop and re-run.'
  }
}

cmd /c "docker compose version >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  Die "Docker Compose v2 plugin not found ('docker compose'). Update Docker Desktop."
}

$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) { Die "Node $MinNodeMajor+ required (found $(node -v)). Upgrade Node." }
Ok "git, docker, compose, node $(node -v) present"

# ---- clone / update ---------------------------------------------------------
if (Test-Path (Join-Path $Dir '.git')) {
  Say "Updating existing checkout at $Dir"
  git -C $Dir fetch --depth 1 origin $Version
  if ($LASTEXITCODE -ne 0) { Die 'git fetch failed.' }
  git -C $Dir checkout -q FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { Die "Local changes in $Dir block the update - resolve them, then re-run." }
} elseif (Test-Path $Dir) {
  Die "$Dir exists but isn't a Spectre checkout. Move it aside or set SPECTRE_DIR."
} else {
  Say "Cloning Spectre into $Dir"
  git clone --depth 1 --branch $Version $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Die 'git clone failed (is spectre-agent public yet?).' }
}
Ok 'Source ready'

# ---- hand off to the Node wizard --------------------------------------------
Set-Location $Dir
Say 'Launching the setup wizard...'
# 'irm | iex' runs us in the current console, so node inherits the real
# terminal - the Supabase / token / PIN prompts work normally.
node installer/install.mjs
