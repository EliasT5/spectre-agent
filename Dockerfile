# Spectre shell — the PUBLIC UI + thin /api proxy to the opaque core.
#
# This is the front door: it serves the blob UI on both mobile + desktop and
# forwards every /api/* call to the core on the compose network (injecting
# CORE_TOKEN). It holds NO moat source — the brain lives in the opaque
# spectre-core image. The browser holds NO storage credentials either: chat
# streams over the core's SSE thread feed through the proxy, so no Supabase
# values are baked into this image.

FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

# ---- deps ----
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build (Next standalone) ----
FROM base AS builder
WORKDIR /app
# Inlined at build time (passed by docker compose). Default "/code" = the
# same-origin edge proxy route for the embedded editor.
ARG NEXT_PUBLIC_CODE_SERVER_URL=/code
ENV NEXT_PUBLIC_CODE_SERVER_URL=$NEXT_PUBLIC_CODE_SERVER_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
# Next standalone app + its static assets (must be copied alongside; Next does
# not bundle them into standalone). public/ holds the service worker + the
# Code-mode sandbox runtime, so it must ship too.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3100
CMD ["node", "server.js"]
