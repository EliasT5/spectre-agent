# workspace-service — standalone dual-mode Workspace backend for Spectre.
#
# Bundles the runtime tools the routes shell out to: git, ripgrep (rg), and the
# GitHub CLI (gh). gh + git use the server-injected GH_TOKEN (env, never client).
FROM node:20-bookworm-slim

# ---------------------------------------------------------------------------
# System deps: git + ripgrep + ca-certificates + curl, then the GitHub CLI
# from its official apt repository.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ripgrep \
      ca-certificates \
      curl \
      gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install

# Build the TypeScript service.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Sandbox slot root (cloned repos live here). Trusted folders are bind-mounted
# at runtime and registered via WORKSPACE_TRUSTED_DIRS.
ENV WORKSPACE_ROOT=/workspaces
RUN mkdir -p /workspaces && chown node:node /workspaces

# Non-root: this service edits files and runs untrusted repo code (npm test /
# shell), so it must not be root. `node` is uid 1000 — the same uid as the
# code-server image's `coder` user, so files on the shared spectre-workspaces
# volume stay mutually writable. Pre-existing volumes from the root-era image
# may need a one-time `chown -R 1000:1000 /workspaces`.
USER node

EXPOSE 8010

CMD ["node", "dist/server.js"]
