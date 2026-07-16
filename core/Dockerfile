# Spectre core — standalone bun BINARIES (no Next.js runtime needed).
#
# The build stage compiles 5 standalone binaries via `bun build --compile`
# (spectre-core / -broker / -chat-runner / -scheduler / -worker). The runtime
# stage ships those binaries + the prompt DATA they read at runtime (soul/
# skills) + the SQL — no node, no bun needed at runtime. The brain is
# provider-agnostic via the LiteLLM gateway; the subscription CLIs are off by
# default (operator opt-in) and run from the host, so they're not bundled in
# the image.

# ---- build: compile the bun binaries ----
# --platform=$BUILDPLATFORM: run the builder on the NATIVE host arch (no QEMU) and
# let bun CROSS-COMPILE to the target arch below, so a `docker buildx build
# --platform linux/amd64,linux/arm64 --push` produces a multi-arch image (native
# Apple Silicon, no Rosetta) without emulating the whole build.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /app
# Core deps (bun resolves from package.json; the lockfile is a hint).
COPY package.json package-lock.json* ./
RUN bun install
# The MCP broker pins its OWN deps (zod v3 + MCP SDK) — install in its dir.
COPY spectre-mcp-broker/package.json spectre-mcp-broker/package-lock.json* ./spectre-mcp-broker/
RUN cd spectre-mcp-broker && bun install
COPY . .
# TARGETARCH is injected by buildx (amd64 | arm64). Map it to bun's --compile
# target so each platform gets a native binary; defaults to x64 for a plain
# `docker build` (BuildKit sets TARGETARCH to the host arch, empty on old builders).
ARG TARGETARCH
RUN BUN_TARGET=bun-linux-x64; \
    if [ "$TARGETARCH" = "arm64" ]; then BUN_TARGET=bun-linux-arm64; fi; \
    echo "compiling for $BUN_TARGET (TARGETARCH=$TARGETARCH)"; \
    bun scripts/build.mjs --target=$BUN_TARGET

# ---- runtime: binaries + prompt data only (no bun/node) ----
FROM debian:bookworm-slim AS runner
WORKDIR /app
# The git SHA this image was built from (baked in by scripts/spectre-update.mjs
# via --build-arg / the compose `args:` entry). The core's /api/update/status
# compares it against origin/main to detect available updates. Empty = unknown.
ARG SPECTRE_BUILD_SHA=
ENV SPECTRE_BUILD_SHA=$SPECTRE_BUILD_SHA
ENV PORT=8787 \
    HOSTNAME=0.0.0.0 \
    SPECTRE_REPO_PATH=/app \
    SPECTRE_MCP_BROKER=1 \
    SPECTRE_MCP_BROKER_BIN=/app/dist/spectre-broker
# 0.0.0.0 is correct INSIDE the container; loopback-only exposure is enforced by
# the compose port mapping (127.0.0.1:8787:8787). Never publish :8787 publicly
# without an auth proxy — the core trusts CORE_TOKEN alone.
#
# git: the workshop self-edit loop. ca-certificates: outbound TLS (Supabase, the
# gateway). No node, no bun bundled — the binaries are self-contained.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global --add safe.directory '*'

# Optional: bundle the subscription "brain" CLIs (Claude Code + Codex) INTO the
# image so they work in the CONTAINERIZED core (the CLIs otherwise run from the
# host, which a container can't reach). OFF by default — host-run cores don't need
# it. Enable via .env.docker (INSTALL_CLIS=1) or:
#   docker compose build --build-arg INSTALL_CLIS=1 core
# Auth (all UI/env, no image rebuild): Claude → CLAUDE_CODE_OAUTH_TOKEN (from
# `claude setup-token`, settable in Settings); Codex → an OpenAI API key in Settings
# (OPENAI_API_KEY), or mount your host ~/.codex login for ChatGPT-subscription auth.
ARG INSTALL_CLIS=0
RUN if [ "$INSTALL_CLIS" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends nodejs npm \
      && npm install -g @anthropic-ai/claude-code @openai/codex \
      && npm cache clean --force \
      && rm -rf /var/lib/apt/lists/* \
      && claude --version && codex --version; \
    fi

# The compiled binaries.
COPY --from=build /app/dist/ ./dist/
# Runtime DATA the binaries read (persona + skills the soul builder reads, and the
# schema). This is prompt/config data, kept as plain files alongside the binaries.
COPY --from=build /app/soul ./soul
COPY --from=build /app/skills ./skills
COPY --from=build /app/supabase ./supabase
# The MCP tool catalog the compiled core reads at runtime (mcp-catalog.ts renders
# it into the model's authoritative tool-list prompt block; /api/mcp serves it).
# SPECTRE_REPO_PATH=/app, so it must live at /app/spectre-mcp-broker/.
COPY --from=build /app/spectre-mcp-broker/tools-catalog.json ./spectre-mcp-broker/tools-catalog.json

EXPOSE 8787
# Default = the core API server. Compose overrides `command` for the satellites.
CMD ["/app/dist/spectre-core"]
