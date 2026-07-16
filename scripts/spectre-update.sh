#!/usr/bin/env bash
# Spectre self-update bootstrap — thin wrapper around scripts/spectre-update.mjs.
# Works even when the shell/core containers are gone: it only needs the repo
# checkout, git, node and docker on the HOST.
#
# Usage (from the repo):
#   ./scripts/spectre-update.sh --check                # am I behind origin/main?
#   ./scripts/spectre-update.sh --apply                # pull + rebuild + recreate
#   ./scripts/spectre-update.sh --apply --target core  # core + runners only
#
# Emergency entry when the local copy of this script is broken/missing — fetch
# it straight from GitHub (the repo is PRIVATE, so authenticate the raw fetch)
# and run it against your checkout:
#   cd /path/to/spectre_dev && \
#   curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#     https://raw.githubusercontent.com/EliasT5/spectre-agent/main/scripts/spectre-update.sh \
#     | bash -s -- --apply
# (When piped, the script locates the repo via $SPECTRE_DIR or the current
#  directory instead of its own path.)

set -euo pipefail

# Locate the repo root: this script's parent dir → $SPECTRE_DIR → $PWD.
candidates=()
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  candidates+=("$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")
fi
[ -n "${SPECTRE_DIR:-}" ] && candidates+=("$SPECTRE_DIR")
candidates+=("$PWD")

repo=""
for c in "${candidates[@]}"; do
  if [ -f "$c/docker-compose.yml" ] && [ -f "$c/scripts/spectre-update.mjs" ]; then
    repo="$c"
    break
  fi
done

if [ -z "$repo" ]; then
  echo "✗ Could not locate the Spectre repo (looked for docker-compose.yml + scripts/spectre-update.mjs)." >&2
  echo "  cd into your spectre checkout, or set SPECTRE_DIR=/path/to/spectre_dev." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ node is required but not on PATH (install Node.js 18+)." >&2
  exit 1
fi

exec node "$repo/scripts/spectre-update.mjs" "$@"
