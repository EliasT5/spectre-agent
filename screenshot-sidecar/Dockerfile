# Screenshot sidecar — headless Chromium via Playwright. The base image ships the
# matching browser binaries under /ms-playwright, so we skip the browser download
# (the npm install just wires up the playwright package at the same version).
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev
COPY shotter.mjs ./
EXPOSE 8008
CMD ["node", "shotter.mjs"]
