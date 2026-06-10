#!/bin/sh
# Spectre -- one-line installer bootstrap.
#
#   curl -fsSL https://YOUR-SITE/install.sh | sh
#
# Security-conscious? Download and read it first, then run:
#   curl -fsSL https://YOUR-SITE/install.sh -o install.sh
#   less install.sh && sh install.sh
#
# This script only checks prerequisites, fetches the Spectre shell, and hands
# off to the interactive setup wizard (installer/install.mjs). It writes nothing
# outside the install directory. Override defaults with env vars:
#   SPECTRE_REPO     git URL of the public shell   (default below)
#   SPECTRE_VERSION  tag or branch to check out     (default: main)
#   SPECTRE_DIR      where to install               (default: ~/spectre)
set -eu

SPECTRE_REPO="${SPECTRE_REPO:-https://github.com/EliasT5/spectre-agent.git}"
SPECTRE_VERSION="${SPECTRE_VERSION:-main}"
SPECTRE_DIR="${SPECTRE_DIR:-$HOME/spectre}"
MIN_NODE_MAJOR=20

# -- ANSI helpers (TTY only) --------------------------------------------------
if [ -t 1 ]; then
  B="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  G="$(printf '\033[32m')"; Y="$(printf '\033[33m')"
  R="$(printf '\033[31m')"; X="$(printf '\033[0m')"
  IT="$(printf '\033[3m')"
else
  B=""; DIM=""; G=""; Y=""; R=""; X=""; IT=""
fi
say()  { printf '%s\n' "  ${B}>${X} $*"; }
ok()   { printf '%s\n' "  ${G}+${X} $*"; }
warn() { printf '%s\n' "  ${Y}!${X} $*"; }
die()  { printf '%s\n' "  ${R}x${X} $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# -- banner -------------------------------------------------------------------
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
  # Block char and middot built at runtime -- no non-ASCII literals in source.
  FB="$(printf '\342\226\210')"
  MD="$(printf '\302\267')"
  render_row() {
    # Replace every '#' in the template with the full-block char.
    printf '%s\n' "$2" | sed "s/#/$FB/g"
  }
  printf '\n'
  printf '\033[38;5;135m'; render_row 135 " ####### ######  #######  ###### ######## ######  #######"; printf '\033[0m'
  printf '\033[38;5;141m'; render_row 141 " ##      ##   ## ##      ##         ##    ##   ## ##"; printf '\033[0m'
  printf '\033[38;5;147m'; render_row 147 " ####### ######  #####   ##         ##    ######  #####"; printf '\033[0m'
  printf '\033[38;5;177m'; render_row 177 "      ## ##      ##      ##         ##    ##   ## ##"; printf '\033[0m'
  printf '\033[38;5;183m'; render_row 183 " ####### ##      #######  ######    ##    ##   ## #######"; printf '\033[0m'
  printf '\n'
  printf "${IT}  It's your assistant. Haunt your own machine.${X}\n"
  printf "${DIM}  self-hosted ${MD} any model ${MD} governed autonomy${X}\n"
  printf '\n'
else
  say "Spectre installer"
fi

# -- root guard ---------------------------------------------------------------
if [ "$(id -u)" -eq 0 ] && [ -z "${SPECTRE_ALLOW_ROOT:-}" ]; then
  die "Don't run this as root -- the stack runs as your user." \
      "(Set SPECTRE_ALLOW_ROOT=1 to override.)"
fi

# -- OS check -----------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ok "OS: $OS" ;;
  *)
    die "Unsupported OS '$OS'. On Windows, use the PowerShell installer (see the docs)."
    ;;
esac

# -- prerequisite detection ---------------------------------------------------
missing=""
have git    || missing="$missing git"
have docker || missing="$missing docker"
if have node; then
  NODE_MAJOR_CHECK="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR_CHECK" -lt "$MIN_NODE_MAJOR" ]; then
    missing="$missing node"
  fi
else
  missing="$missing node"
fi

if [ -n "$missing" ]; then
  # CI / no TTY: die with manual instructions (unchanged behavior).
  if [ ! -e /dev/tty ]; then
    die "Missing prerequisites:$missing -- install them, then re-run."
  fi

  warn "Missing prerequisites:$missing"
  printf '  %s>%s Install missing prerequisites now? [Y/n]: ' "$B" "$X" >/dev/tty
  read -r _consent </dev/tty || true
  case "${_consent:-Y}" in
    [Yy]|[Yy][Ee][Ss]|"") : ;;
    *) die "Missing prerequisites:$missing -- install them, then re-run." ;;
  esac

  # -- detect package manager -------------------------------------------------
  PM=""
  if [ "$OS" = "Darwin" ]; then
    have brew && PM="brew"
  else
    have apt-get && PM="apt-get"
    [ -z "$PM" ] && have dnf    && PM="dnf"
    [ -z "$PM" ] && have pacman && PM="pacman"
    [ -z "$PM" ] && have zypper && PM="zypper"
    [ -z "$PM" ] && have apk    && PM="apk"
  fi
  [ -z "$PM" ] && die \
    "No supported package manager found (apt-get/dnf/pacman/zypper/apk/brew)." \
    "Install prerequisites manually:$missing"

  # -- sudo setup -------------------------------------------------------------
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  else
    have sudo || die "sudo is required to install packages but was not found."
    SUDO="sudo"
  fi

  # -- install git ------------------------------------------------------------
  case "$missing" in *git*)
    say "Installing git via $PM..."
    case "$PM" in
      apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y git ;;
      dnf)     $SUDO dnf install -y git ;;
      pacman)  $SUDO pacman -Sy --noconfirm git ;;
      zypper)  $SUDO zypper install -y git ;;
      apk)     $SUDO apk add --no-cache git ;;
      brew)    brew install git ;;
    esac
    have git || die "git install failed -- install it manually and re-run."
    ok "git installed"
  ;; esac

  # -- install node -----------------------------------------------------------
  case "$missing" in *node*)
    say "Installing Node.js ${MIN_NODE_MAJOR}+ via $PM..."
    case "$PM" in
      apt-get)
        curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
        $SUDO apt-get install -y nodejs
        ;;
      dnf)
        curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
        $SUDO dnf install -y nodejs
        ;;
      pacman)  $SUDO pacman -Sy --noconfirm nodejs npm ;;
      zypper)  $SUDO zypper install -y nodejs22 ;;
      apk)     $SUDO apk add --no-cache nodejs npm ;;
      brew)    brew install node ;;
    esac
    have node || die "node install failed -- install Node ${MIN_NODE_MAJOR}+ manually and re-run."
    ok "node $(node -v) installed"
  ;; esac

  # -- install docker ---------------------------------------------------------
  case "$missing" in *docker*)
    say "Installing Docker via $PM..."
    if [ "$OS" = "Darwin" ]; then
      brew install --cask docker
      warn "Docker Desktop installed. Open Docker.app to start the daemon, then re-run."
      exit 0
    else
      curl -fsSL https://get.docker.com | $SUDO sh
      $SUDO usermod -aG docker "$USER" || true
      warn "Docker group updated -- log out/in (or run: newgrp docker) for changes to take effect."
      if have systemctl; then
        $SUDO systemctl enable --now docker || true
      fi
      have docker || die "docker install failed -- install it manually and re-run."
      ok "docker installed"
    fi
  ;; esac
fi

# -- docker running check -----------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  if have systemctl; then
    say "Docker not running -- attempting to start it..."
    ${SUDO:-sudo} systemctl start docker 2>/dev/null || true
  fi
  if ! docker info >/dev/null 2>&1; then
    _docker_err="$(docker info 2>&1 || true)"
    case "$_docker_err" in
      *permission*)
        die "Docker is running but this user lacks permission. Run: newgrp docker -- then re-run." ;;
      *)
        die "Docker is installed but not running. Start Docker and re-run." ;;
    esac
  fi
fi
docker compose version >/dev/null 2>&1 || \
  die "Docker Compose v2 plugin not found ('docker compose'). Update Docker."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || \
  die "Node ${MIN_NODE_MAJOR}+ required (found $(node -v)). Upgrade Node."
ok "git, docker, compose, node $(node -v) present"

# -- clone / update -----------------------------------------------------------
if [ -d "$SPECTRE_DIR/.git" ]; then
  say "Updating existing checkout at $SPECTRE_DIR"
  git -C "$SPECTRE_DIR" fetch --depth 1 origin "$SPECTRE_VERSION"
  git -C "$SPECTRE_DIR" checkout -q FETCH_HEAD || \
    die "Local changes in $SPECTRE_DIR block the update -- resolve them, then re-run."
elif [ -e "$SPECTRE_DIR" ]; then
  die "$SPECTRE_DIR exists but isn't a Spectre checkout. Move it aside or set SPECTRE_DIR."
else
  say "Cloning Spectre into $SPECTRE_DIR"
  git clone --depth 1 --branch "$SPECTRE_VERSION" "$SPECTRE_REPO" "$SPECTRE_DIR"
fi
ok "Source ready"

# -- hand off to the Node wizard ----------------------------------------------
cd "$SPECTRE_DIR"
say "Launching the setup wizard..."
# Under 'curl | sh' our stdin is the pipe, not the keyboard. The wizard is
# interactive (Supabase, token, PIN), so give it the real terminal.
if [ -e /dev/tty ]; then
  node installer/install.mjs </dev/tty
else
  warn "No terminal detected (piped/CI). Finish setup yourself:"
  printf '    cd %s && node installer/install.mjs\n' "$SPECTRE_DIR"
fi
