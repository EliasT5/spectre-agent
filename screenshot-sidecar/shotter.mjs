// Tiny headless-Chromium screenshot service (Playwright). The core's `screenshot`
// MCP tool POSTs here; we render a URL and return a PNG. Kept as a sidecar behind
// the `screenshot` compose profile so the slim base install carries no ~400MB
// Chromium layer. Loopback within the compose network only.
import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.SHOTTER_PORT || 8008);
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  return browser;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (req.method !== "POST" || req.url !== "/shot") {
    res.writeHead(404);
    return res.end("not found");
  }
  const opts = await readBody(req);
  if (!opts.url || typeof opts.url !== "string") {
    res.writeHead(400);
    return res.end("url required");
  }
  let ctx;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({
      viewport: { width: Number(opts.width) || 1280, height: Number(opts.height) || 800 },
      // Optional cookie/header so the tool can capture an authed page (e.g. the
      // session-gated shell) when the operator supplies SPECTRE_SHOTTER_COOKIE.
      ...(opts.cookie ? { extraHTTPHeaders: { Cookie: String(opts.cookie) } } : {}),
    });
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: "networkidle", timeout: Number(opts.timeoutMs) || 30000 });
    let buf;
    if (opts.selector) {
      const el = await page.$(String(opts.selector));
      if (!el) throw new Error(`selector not found: ${opts.selector}`);
      buf = await el.screenshot({ type: "png" });
    } else {
      buf = await page.screenshot({ fullPage: !!opts.fullPage, type: "png" });
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(e?.message || e));
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
});

server.listen(PORT, () => console.log(`[shotter] listening on :${PORT}`));
