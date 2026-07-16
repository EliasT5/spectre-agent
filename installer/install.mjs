#!/usr/bin/env node
// Spectre installer -- cross-platform Docker wizard.
//
//   node installer/install.mjs            # interactive install
//   node installer/install.mjs --dry-run  # detect + show the plan, write nothing
//   node installer/install.mjs --check    # just the environment report
//   node installer/install.mjs --uninstall          # stop containers + remove networks (keeps data)
//   node installer/install.mjs --uninstall --purge  # also delete volumes + .env files (irreversible)
//   node installer/install.mjs --uninstall --yes    # skip confirmation prompt (non-interactive)
//
// Re-running on an existing install opens a manage menu (rebuild the core,
// rebuild the shell, reconfigure, or uninstall) instead of redoing first-time setup.
//
// Brings up the full stack: detect Docker + connector CLIs -> collect your
// Supabase + Claude token -> generate CORE_TOKEN / SESSION_SECRET / PIN_HASH ->
// write .env.docker -> sequential pre-pull of all images -> local-db up + schema ->
// docker compose up -> health-check the core -> print your loopback + tailnet links.
// The raw PIN is hashed and never stored.
//
// Dependency-free (Node 22 built-ins only). Run from the repo root.

import { createHash, randomBytes } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir, totalmem, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { CONNECTORS, API_PROVIDERS, LOCAL_DAEMONS } from "./connectors.mjs";
import { ollamaModels } from "./guide.mjs";
import { chooseNarrator } from "./narrator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENV_PATH = join(ROOT, ".env.docker");

// ---- pure helpers (exported for tests) --------------------------------------

export const genHex = (bytes = 32) => randomBytes(bytes).toString("hex");
export const pinHash = (pin) => createHash("sha256").update(String(pin)).digest("hex");
export function pinError(pin) {
  const s = String(pin);
  if (!/^\d{6,}$/.test(s)) return "PIN must be at least 6 digits.";
  if (/^(\d)\1+$/.test(s)) return "PIN cannot be the same digit repeated.";
  if (["0000", "1234", "123456"].includes(s)) return "PIN is too common.";
  const digits = [...s].map(Number);
  const asc = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10);
  const desc = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10);
  if (asc || desc) return "PIN cannot be a simple sequence.";
  return null;
}

/** Run a command through the shell; return trimmed stdout or null on failure. */
export function tryCmd(cmd, timeout = 12000) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], timeout, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Detect a CLI on PATH cross-platform (shell resolves .cmd/.exe on Windows). */
export function detectBin(bin, versionFlag = "--version") {
  const out = tryCmd(`${bin} ${versionFlag}`);
  return out ? { found: true, version: out.split("\n")[0].trim() } : { found: false, version: null };
}

/** Is a TCP port already taken on loopback? Bind-and-release -- works on every OS
 *  (no netstat/lsof parsing). Resolves true if EADDRINUSE. */
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

/** Warn (don't block) about host ports the stack needs that are already taken. */
async function checkPorts(ports) {
  const taken = [];
  for (const { port, who } of ports) if (await portInUse(port)) taken.push({ port, who });
  if (taken.length) {
    console.log(C.warn("\n  ! some ports the stack needs are already in use:"));
    for (const t of taken) console.log(C.dim(`     ${t.port}  (${t.who})`));
    console.log(C.dim(
      "     Free them (or change the mapped host port in .env.docker)" +
      " or the bring-up will fail.\n"
    ));
  }
  return taken;
}

// Keys that MUST always appear in .env.docker even when blank (compose/core hard-
// wired to read them). All other keys are OMITTED when empty so the file stays clean.
const REQUIRED_ENV_KEYS = new Set([
  "CORE_TOKEN", "PIN_HASH", "SESSION_SECRET", "LITELLM_MASTER_KEY",
  "SPECTRE_SERVICE_TOKEN", "WORKSPACE_SERVICE_TOKEN", "UPDATER_TOKEN", "CODE_SERVER_PASSWORD",
  "COMPOSE_PROFILES", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY", "SHELL_BIND", "SHELL_PORT",
  "SPECTRE_LITELLM_MODEL",
  "OLLAMA_DISTILL_MODEL", "OLLAMA_LEARN_MODEL", "OLLAMA_EMBED_MODEL",
]);

/** Render an ordered values object to a .env file body.
 *  Required keys are always written (blank or not); optional keys are only
 *  written when they carry a non-empty value, so the file never accumulates
 *  KEY="" noise on re-runs. Keys whose name starts with "#" are emitted as
 *  comment lines (value ignored) -- used for section separators. */
export function renderEnv(values) {
  return (
    Object.entries(values)
      .filter(([k, v]) => k.startsWith("#") || REQUIRED_ENV_KEYS.has(k) || (v !== undefined && v !== null && v !== ""))
      .map(([k, v]) => k.startsWith("#") ? `\n${k}` : `${k}=${v ?? ""}`)
      .join("\n") + "\n"
  );
}

/** Parse an existing .env body into a flat object (for re-runs / dry-run seeds). */
export function parseEnv(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The known env contract keys -- used during re-runs to distinguish "known keys
// managed by the installer" from "hand-added keys the user wants preserved."
const CONTRACT_KEYS = new Set([
  "CORE_TOKEN", "PIN_HASH", "SESSION_SECRET", "LITELLM_MASTER_KEY",
  "SPECTRE_LITELLM_MODEL", "SPECTRE_SERVICE_TOKEN",
  "SPECTRE_ALLOW_CLAUDE_CLI", "SPECTRE_ALLOW_CODEX_CLI", "SPECTRE_ALLOW_GEMINI_CLI", "SPECTRE_ALLOW_CLI_BACKENDS",
  "WORKSPACE_SERVICE_TOKEN", "UPDATER_TOKEN", "WORKSPACE_TRUSTED_DIRS", "CODE_SERVER_PASSWORD",
  "GH_TOKEN", "COMPOSE_PROFILES",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_SENDER_IDS",
  "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET", "WHATSAPP_ALLOWED_SENDER_IDS",
  "DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_SENDER_IDS",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OLLAMA_DISTILL_MODEL", "OLLAMA_LEARN_MODEL", "OLLAMA_EMBED_MODEL",
  "SHELL_BIND", "SHELL_PORT",
  ...API_PROVIDERS.map((p) => p.envVars[0]),
]);

/** The full ordered env contract (every compose service reads this).
 *  seed: the parsed prior .env.docker (for re-run carry-forward of unknown keys). */
export function buildEnv(v, seed = {}) {
  const core = {
    CORE_TOKEN: v.CORE_TOKEN,
    PIN_HASH: v.PIN_HASH,
    SESSION_SECRET: v.SESSION_SECRET,
    LITELLM_MASTER_KEY: v.LITELLM_MASTER_KEY,
    SPECTRE_LITELLM_MODEL: v.SPECTRE_LITELLM_MODEL ?? "spectre-default",
    SPECTRE_SERVICE_TOKEN: v.SPECTRE_SERVICE_TOKEN,
    SPECTRE_ALLOW_CLAUDE_CLI: v.SPECTRE_ALLOW_CLAUDE_CLI ?? "",
    SPECTRE_ALLOW_CODEX_CLI: v.SPECTRE_ALLOW_CODEX_CLI ?? "",
    SPECTRE_ALLOW_GEMINI_CLI: v.SPECTRE_ALLOW_GEMINI_CLI ?? "",
    // User-taught model backends whose cli-server/cli-command kinds spawn operator
    // commands (RCE by design) — off by default, opt in like the CLI-UI flag.
    SPECTRE_ALLOW_CLI_BACKENDS: v.SPECTRE_ALLOW_CLI_BACKENDS ?? "",
    // Workspaces (opt-in `--profile workspace`): the shell->workspace-service token,
    // optional GitHub token for clone/push/PR, and trusted local folders.
    WORKSPACE_SERVICE_TOKEN: v.WORKSPACE_SERVICE_TOKEN,
    WORKSPACE_TRUSTED_DIRS: v.WORKSPACE_TRUSTED_DIRS ?? "",
    // code-server's own login (defense-in-depth behind the shell PIN -- the
    // editor is file edit + terminal on the mounted workspaces).
    CODE_SERVER_PASSWORD: v.CODE_SERVER_PASSWORD,
    GH_TOKEN: v.GH_TOKEN ?? "",
    // Which compose profiles run (the chosen install profile). "" = headless
    // (core + channels + API, no shell); "ui" = + shell; "ui,workspace" = + IDE.
    COMPOSE_PROFILES: v.COMPOSE_PROFILES ?? "ui",
    // Messaging channels (set by the channel picker; blank = off).
    TELEGRAM_BOT_TOKEN: v.TELEGRAM_BOT_TOKEN ?? "",
    TELEGRAM_WEBHOOK_SECRET: v.TELEGRAM_WEBHOOK_SECRET ?? "",
    TELEGRAM_ALLOWED_SENDER_IDS: v.TELEGRAM_ALLOWED_SENDER_IDS ?? "",
    WHATSAPP_TOKEN: v.WHATSAPP_TOKEN ?? "",
    WHATSAPP_PHONE_NUMBER_ID: v.WHATSAPP_PHONE_NUMBER_ID ?? "",
    WHATSAPP_VERIFY_TOKEN: v.WHATSAPP_VERIFY_TOKEN ?? "",
    WHATSAPP_APP_SECRET: v.WHATSAPP_APP_SECRET ?? "",
    WHATSAPP_ALLOWED_SENDER_IDS: v.WHATSAPP_ALLOWED_SENDER_IDS ?? "",
    DISCORD_BOT_TOKEN: v.DISCORD_BOT_TOKEN ?? "",
    DISCORD_ALLOWED_SENDER_IDS: v.DISCORD_ALLOWED_SENDER_IDS ?? "",
    NEXT_PUBLIC_SUPABASE_URL: v.NEXT_PUBLIC_SUPABASE_URL,
    // Cloud: identical to the browser URL. Local self-hosted DB: the core reaches
    // the gateway server-side (http://host.docker.internal:8000) while the browser
    // uses http://localhost:8000, so they differ -- keep them separate.
    SUPABASE_URL: v.SUPABASE_URL || v.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: v.SUPABASE_SERVICE_ROLE_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: v.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    // Provider API keys -- one entry per registry provider (canonical var only).
    // Optional: renderEnv omits blank values so the file stays clean.
    ...Object.fromEntries(API_PROVIDERS.map((p) => [p.envVars[0], v[p.envVars[0]] ?? ""])),
    OLLAMA_DISTILL_MODEL: v.OLLAMA_DISTILL_MODEL ?? "gemma3",
    OLLAMA_LEARN_MODEL: v.OLLAMA_LEARN_MODEL ?? "gemma3",
    OLLAMA_EMBED_MODEL: v.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
    SHELL_BIND: v.SHELL_BIND ?? "127.0.0.1",
    SHELL_PORT: v.SHELL_PORT ?? "3100",
  };

  // Carry forward any hand-added keys from the prior .env.docker that the
  // contract doesn't manage. These are appended verbatim so a re-run doesn't
  // silently drop custom vars the user added by hand.
  const carried = {};
  for (const [k, val] of Object.entries(seed)) {
    if (!CONTRACT_KEYS.has(k) && val !== undefined && val !== "") carried[k] = val;
  }

  if (Object.keys(carried).length === 0) return core;

  // renderEnv sees a flat object; carried keys are marked with a comment via a
  // sentinel key that renderEnv will emit literally.
  return { ...core, "# carried from previous install": undefined, ...carried };
}

// ---- reporting --------------------------------------------------------------

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  accent: (s) => `\x1b[38;5;99m${s}\x1b[0m`,
  p: (code, s) => `\x1b[38;5;${code}m${s}\x1b[0m`,
};

// Banner art rows as '#'-templates; '#' is replaced with the block char at runtime.
const BANNER_ROWS = [
  [135, " ####### ######  #######  ###### ######## ######  #######"],
  [141, " ##      ##   ## ##      ##         ##    ##   ## ##"],
  [147, " ####### ######  #####   ##         ##    ######  #####"],
  [177, "      ## ##      ##      ##         ##    ##   ## ##"],
  [183, " ####### ##      #######  ######    ##    ##   ## #######"],
];
const FB = "\u2588"; // full block char -- Unicode escape keeps source ASCII

/** Print the Spectre block-art banner with a 256-color purple row gradient when
 *  stdout is a TTY, otherwise fall back to the two-line plain-text header. */
function printBanner() {
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
    for (const [code, tmpl] of BANNER_ROWS) {
      process.stdout.write(C.p(code, tmpl.replace(/#/g, FB)) + "\n");
    }
    process.stdout.write("\n");
    process.stdout.write("\x1b[3m  It's your assistant. Haunt your own machine.\x1b[0m\n");
    process.stdout.write(C.dim("  self-hosted \xb7 any model \xb7 governed autonomy") + "\n");
    process.stdout.write("\n");
  } else {
    console.log("\n  S P E C T R E  --  installer");
    console.log("  It's your assistant. Haunt your own machine.");
    console.log("  self-hosted - any model - governed autonomy\n");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Clear the screen and reprint the banner, then show a dim step indicator.
 * TTY: full clear (screen + scrollback). Non-TTY: plain section header only.
 * Call once at the START of each major phase; never call mid-phase.
 */
function phase(step, total, label) {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    printBanner();
    process.stdout.write(C.dim(`  step ${step}/${total}  ${label}`) + "\n\n");
  } else {
    console.log(`\n  -- step ${step}/${total}: ${label} --`);
  }
}

/**
 * Run a shell command via spawn and collect stdout + stderr into strings.
 * Resolves { code, stdout, stderr }. Never throws.
 */
function spawnCollect(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
    proc.on("error", (e) => resolve({ code: 1, stdout: "", stderr: e.message }));
  });
}

/**
 * Collect the images declared in a docker compose config (JSON) that have no
 * `build` key (pre-built images only -- never try to pull a locally-built service).
 * composeArgv: the already-split argv array passed to `docker compose`, e.g.
 *   ["-f", "docker-compose.yml", "--env-file", ".env.docker", "--profile", "ui"]
 * Returns a deduped string[] of image references, or [] on failure.
 */
async function collectComposeImages(composeArgv) {
  const res = await spawnCollect("docker", [...composeArgv, "config", "--format", "json"], { cwd: ROOT });
  if (res.code !== 0) return [];
  try {
    const cfg = JSON.parse(res.stdout);
    const imgs = new Set();
    for (const svc of Object.values(cfg.services ?? {})) {
      if (!svc.build && svc.image) imgs.add(svc.image);
    }
    return [...imgs];
  } catch {
    return [];
  }
}

/**
 * Pull a single Docker image quietly with a single-line ticker, retry logic,
 * and a human-readable DNS/network error classifier on final failure.
 *
 * opts.maxAttempts    (default 3)
 * opts.retryDelays    (default [5000, 15000]) -- ms to wait before attempt 2, 3
 * opts.label          (default img) -- short label for the line, max ~50 chars
 *
 * Throws on unrecoverable failure (caller should catch and process.exit(1)).
 */
async function pullImage(img, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delays = opts.retryDelays ?? [5000, 15000];
  const label = (opts.label ?? img).slice(0, 50);

  const NET_RE = /no such host|failed to resolve reference|lookup .* (no such host|server misbehaving)|TLS handshake timeout/i;

  // Overwrite the current line (TTY) or print a new line (non-TTY).
  const printLine = (text) => {
    const safe = text.slice(0, 78);
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K" + safe);
    } else {
      console.log(safe);
    }
  };
  const finishLine = (text) => {
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K" + text + "\n");
    } else {
      console.log(text);
    }
  };

  let lastStderr = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = delays[attempt - 2] ?? 15000;
      finishLine(C.warn(`  pull interrupted -- retrying (attempt ${attempt}/${maxAttempts})`));
      await sleep(delay);
    }

    printLine(C.dim(`  pulling ${label}`));
    const start = Date.now();
    let ticker = null;

    if (process.stdout.isTTY) {
      let dots = 0;
      ticker = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const dotStr = ".".repeat((dots % 3) + 1).padEnd(3);
        dots++;
        printLine(C.dim(`  pulling ${label} ${dotStr} ${elapsed}s`));
      }, 500);
    }

    const res = await spawnCollect("docker", ["pull", "-q", img]);

    if (ticker) clearInterval(ticker);
    lastStderr = res.stderr.trim();

    if (res.code === 0) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      finishLine(C.ok(`  ${label}`) + C.dim(`  ok (${elapsed}s)`));
      return; // success
    }

    // failure -- will retry or fall through to classifier
  }

  // All attempts exhausted.
  if (NET_RE.test(lastStderr)) {
    console.log(C.err(`\n  x Docker cannot resolve the registry for: ${img}`));
    console.log(C.err("    Usually Docker Desktop DNS or a VPN/firewall is blocking registry-1.docker.io."));
    console.log(C.dim("    Fix: open Docker Desktop -> Settings -> Docker Engine and add:"));
    console.log(C.dim('         "dns": ["8.8.8.8", "8.8.4.4"]'));
    console.log(C.dim("    Then restart Docker Desktop and re-run the installer."));
  } else {
    console.log(C.err(`\n  x pull failed for: ${img}`));
    if (lastStderr) console.log(C.dim("    " + lastStderr.split("\n")[0]));
  }
  throw new Error(`pull failed: ${img}`);
}

/**
 * Is an image reference immutable -- i.e. pinned so it can never point at a
 * different image later? A `@sha256:` digest pin or any version tag other than
 * the moving `:latest` qualifies. Untagged refs default to `:latest`, so they
 * are mutable. Used to decide what may be skipped when already cached vs. what
 * must be re-pulled on every run (so re-runs pick up a newer published image,
 * notably the core's `:latest`).
 */
export function isImmutableRef(img) {
  if (img.includes("@")) return true; // name@sha256:... -- digest-pinned
  // Strip any registry "host:port/" prefix: a ':' before the last '/' is a port.
  const lastSlash = img.lastIndexOf("/");
  const name = lastSlash === -1 ? img : img.slice(lastSlash + 1);
  const colon = name.lastIndexOf(":");
  if (colon === -1) return false; // untagged -> implicit :latest -> mutable
  return name.slice(colon + 1) !== "latest";
}

/**
 * Sequential pre-pull stage: collect every pre-built image from both the
 * local-db compose (when useLocalDb=true) and the main compose, dedupe, then
 * for each: re-pull mutable tags (`:latest`/untagged, e.g. the core) so re-runs
 * land updates, while skipping immutable pinned refs that are already cached.
 *
 * mainArgv:    split argv for the main docker compose invocation
 * localDbArgv: split argv for the local-db compose (or null)
 *
 * A failed refresh of an image that is already cached is non-fatal (offline /
 * registry-down re-runs keep working on the cached copy); only a genuinely
 * missing image throws.
 */
async function prePullImages(mainArgv, localDbArgv) {
  const allImages = new Set();

  if (localDbArgv) {
    for (const img of await collectComposeImages(localDbArgv)) allImages.add(img);
  }
  for (const img of await collectComposeImages(mainArgv)) allImages.add(img);

  if (allImages.size === 0) {
    console.log(C.dim("  (no pre-built images found in compose config -- skipping pre-pull)"));
    return;
  }

  console.log(C.dim(`  ${allImages.size} image(s) to verify\n`));

  for (const img of allImages) {
    const present = (await spawnCollect("docker", ["image", "inspect", img])).code === 0;

    // A pinned/digest ref that's already cached can never change -- skip the
    // network round-trip (also keeps offline re-runs fast).
    if (present && isImmutableRef(img)) {
      console.log(C.dim(`  ${img.slice(0, 50)}`) + C.dim("  already present"));
      continue;
    }

    // Mutable tag (e.g. the core's :latest) or a missing image: (re-)pull so a
    // re-run actually picks up a newer published image. `docker pull` of an
    // already-current tag is a cheap manifest check (no layer download).
    try {
      await pullImage(img, { label: present ? `${img.slice(0, 38)}  (refresh)` : img });
    } catch (e) {
      // Refresh failed (offline / registry unreachable). Fall back to the cached
      // copy when we have one; only a genuinely missing image is fatal.
      if (present) {
        console.log(C.warn(`  ! couldn't refresh ${img.slice(0, 50)} -- using the cached copy`));
      } else {
        throw e;
      }
    }
  }

  console.log(C.ok("\n  + all images ready"));
}

export function detectDocker() {
  const docker = detectBin("docker");
  const compose = tryCmd("docker compose version");
  return { docker, compose: compose ? { found: true, version: compose.split("\n")[0].trim() } : { found: false, version: null } };
}

export function detectConnectors() {
  return CONNECTORS.filter((c) => c.bin).map((c) => ({ ...c, ...detectBin(c.bin) }));
}

/**
 * Scan shell env + a parsed prior .env.docker seed for provider API keys,
 * and probe local model daemons. Returns:
 *   { keys: [{ provider, label, envVar, value, source }], daemons: [{ id, label }] }
 *
 * For each provider the FIRST hit across envVars wins; shell env is checked
 * before the seed file. ollama is intentionally skipped in the fetch loop (the
 * existing ollamaModels() covers it and avoids a duplicate probe).
 */
export async function scanProviders(seed = {}) {
  const keys = [];
  for (const p of API_PROVIDERS) {
    for (const envVar of p.envVars) {
      const shellVal = process.env[envVar];
      if (shellVal) {
        keys.push({ provider: p.id, label: p.label, envVar: p.envVars[0], value: shellVal, source: "shell" });
        break;
      }
      const seedVal = seed[envVar];
      if (seedVal) {
        keys.push({ provider: p.id, label: p.label, envVar: p.envVars[0], value: seedVal, source: "prior install" });
        break;
      }
    }
  }

  const daemons = [];
  for (const d of LOCAL_DAEMONS) {
    if (d.id === "ollama") continue; // handled by ollamaModels() -- don't probe twice
    try {
      const r = await fetch(d.url + d.probePath, { signal: AbortSignal.timeout(1500) });
      if (r.ok) daemons.push({ id: d.id, label: d.label });
    } catch {
      // not running -- skip
    }
  }

  return { keys, daemons };
}

export function tailnetHost() {
  const json = tryCmd("tailscale status --json");
  if (!json) return null;
  try {
    const s = JSON.parse(json);
    const dns = s?.Self?.DNSName?.replace(/\.$/, "");
    return dns || null;
  } catch {
    return null;
  }
}

/**
 * Bring up the bundled local self-hosted Supabase (Postgres + REST + Realtime +
 * gateway), wait for the DB to finish first-boot init, and apply Spectre's schema
 * directly via `docker exec` -- no Supabase account, no PAT, no SQL-editor paste.
 * Keys are generated earlier (in main()) so the .env exists before images are pulled.
 * Throws on failure.
 */
async function setupLocalDb() {
  // local-db/.env was already written by genLocalDbEnv() in main() before this runs.
  // Images are pre-pulled in the downloads phase before this runs.
  console.log(C.dim("   Starting local database (first boot initialises the schema)..."));
  const composeArgs = "-f local-db/docker-compose.yml --env-file local-db/.env";
  execSync(`docker compose ${composeArgs} up -d --quiet-pull`, { cwd: ROOT, stdio: "inherit" });

  // Wait for first-boot init: pg ready AND the standard roles created by migrate.sh.
  process.stdout.write(C.dim("   Waiting for the database to initialise"));
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    const roles = tryCmd(
      `docker exec spectre-db psql -U postgres -tAc "select count(*) from pg_roles where rolname in ('supabase_admin','authenticator','anon','service_role')"`,
      8000,
    );
    if (roles === "4") { ready = true; break; }
    process.stdout.write(C.dim("."));
    await sleep(2000);
  }
  process.stdout.write("\n");
  if (!ready) throw new Error("local DB did not finish initialising -- `docker compose " + composeArgs + " logs db`");

  // Ensure the realtime publication, then apply the (idempotent) schema directly.
  // Both SQLs go in via STDIN, not `psql -c "..."`: a `-c` argument is parsed by
  // the host shell first, where `$$` (the dollar-quote tag) would expand to the
  // shell PID on Unix and corrupt the DO block. STDIN passes bytes through verbatim.
  execSync("docker exec -i spectre-db psql -U postgres -d postgres -q", {
    input:
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') " +
      "THEN CREATE PUBLICATION supabase_realtime; END IF; END $$;",
    stdio: ["pipe", "ignore", "ignore"],
  });
  execSync("docker exec -i spectre-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q", {
    input: readFileSync(join(ROOT, "supabase", "_apply_all.sql")),
    stdio: ["pipe", "ignore", "inherit"],
  });
}

/**
 * Create the persistent, user-extensible data dir (mounted into the core at
 * /data). Drop skills/tools/mcp here and they overlay the baked built-ins and
 * survive restarts. Idempotent -- never clobbers existing user content.
 */
function setupDataDir() {
  const base = join(ROOT, "spectre-data");
  const readmes = {
    skills:
      "# Skills (live)\n\nDrop a `<name>/SKILL.md` here to ADD a skill or OVERRIDE a\n" +
      "built-in one (same folder name wins). The brain reads these on every message;\n" +
      "no restart needed. You can also add/edit skills in the app (Settings -> Skills).\n",
    tools:
      "# Tools (HTTP)\n\nDeclarative HTTP tools the agent can call -- the low-barrier\n" +
      "alternative to writing an MCP server. One tool per `<name>.json`:\n\n" +
      '    { "name": "weather", "description": "Weather for a city",\n' +
      '      "inputSchema": { "city": { "type": "string" } },\n' +
      '      "http": { "method": "GET", "url": "https://api.example.com/w?q={city}",\n' +
      '                "headers": { "Authorization": "Bearer {env.WEATHER_KEY}" } } }\n\n' +
      "{field} = an arg (URL-encoded); {env.NAME} = an env var, but ONLY names you\n" +
      "list in SPECTRE_TOOL_ENV_ALLOW (so a tool can't read CORE_TOKEN/secrets).\n" +
      "HTTP-only by design (no shell). Overlays built-in tools by name.\n",
    mcp:
      "# MCP servers\n\nConnect external Model Context Protocol servers so their\n" +
      "tools reach the brain. Add them to `servers.json`:\n\n" +
      '    { "servers": { "my-server": { "command": "npx", "args": ["-y", "@scope/mcp"], "env": {} } } }\n\n' +
      'or a remote one: `{ "servers": { "remote": { "url": "https://host/mcp" } } }`.\n',
    modules:
      "# Modules (drop-in)\n\nAdd a UI module WITHOUT editing the core or shell. Drop\n" +
      "a folder here:\n\n    modules/<id>/module.json   (a spectre.module.json v2)\n\n" +
      "and it shows up as a blob slot + renders at /m/<id> -- no rebuild, no SQL.\n\n" +
      "- uiMode \"data\": ship a UI Schema v2 in `ui.schema` (rendered on the host kit,\n" +
      "  zero code) -- the recommended path. Copy example/module.json.example to a\n" +
      "  new <id>/module.json to activate it; the built-in `pulse` module is a live ref.\n" +
      "- uiMode \"code\": a sandboxed JS bundle (advanced; sandbox runtime is WIP).\n" +
      "- uiMode \"native\" is NOT allowed here (a native route needs shell source).\n\n" +
      "Schema `data` blocks can use {\"source\":\"sdk\",\"call\":\"health|monitor|usage|...\"};\n" +
      "module-backend endpoints need the capability shim (WIP).\n",
  };
  for (const kind of ["skills", "tools", "mcp", "modules"]) {
    const dir = join(base, kind);
    mkdirSync(dir, { recursive: true });
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) writeFileSync(readme, readmes[kind]);
  }

  // A copy-to-activate Data-mode module template (named .example so the loader,
  // which reads <id>/module.json, ignores it until the user copies it).
  const exDir = join(base, "modules", "example");
  mkdirSync(exDir, { recursive: true });
  const exFile = join(exDir, "module.json.example");
  if (!existsSync(exFile)) writeFileSync(exFile, JSON.stringify(MODULE_EXAMPLE, null, 2) + "\n");

  return base;
}

// A minimal, valid Data-mode module (mirrors the built-in `pulse` shape). Shipped
// as a template; copy to spectre-data/modules/<id>/module.json to activate.
const MODULE_EXAMPLE = {
  schemaVersion: 2,
  id: "example",
  label: "Example",
  version: "0.1.0",
  description: "A drop-in Data-mode module. Copy this folder, rename the id/route, edit the schema.",
  route: "/m/example",
  icon: "Box",
  hint: "data-dir module demo",
  uiMode: "data",
  sdkRange: "^1.0.0",
  permissions: { sdk: ["health", "monitor"] },
  ui: {
    schema: {
      version: 2,
      title: "Example",
      eyebrow: "MODULE - EXAMPLE",
      status: "{{data.health.status}}",
      tone: "ok",
      data: {
        health: { source: "sdk", call: "health" },
        mon: { source: "sdk", call: "monitor", pollMs: 10000 },
      },
      body: [
        {
          kind: "stats",
          label: "LIVE",
          hud: true,
          stats: [
            { k: "critical", n: "{{data.mon.summary.criticals}}", counter: true, color: "var(--color-error)" },
            { k: "warnings", n: "{{data.mon.summary.warnings}}", counter: true },
          ],
        },
      ],
    },
  },
};

// Tool name column width for the environment report table.
const TOOL_COL = 16;

/** Mask an API key value: show the first 4 chars + "..." */
function maskKey(val) {
  if (!val || val.length < 4) return "***";
  return val.slice(0, 4) + "...";
}

function report(scan = null) {
  const { docker, compose } = detectDocker();
  const conns = detectConnectors();
  const host = tailnetHost();

  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Environment"));

  const line = (label, d) => {
    const dot = d.found ? C.ok("o") : C.dim("x");
    const name = label.padEnd(TOOL_COL);
    const detail = d.found ? C.dim(d.version || "found") : C.dim("not found");
    console.log(`   ${dot} ${name} ${detail}`);
  };
  line("docker", docker);
  line("docker compose", compose);
  for (const c of conns) line(c.label.split(" -- ")[0], c);
  {
    const dot = host ? C.ok("o") : C.dim("x");
    const name = "tailscale".padEnd(TOOL_COL);
    const detail = host ? C.dim(host) : C.dim("not detected");
    console.log(`   ${dot} ${name} ${detail}`);
  }

  // Detected provider keys + local daemons from the scan (Phase-1 only).
  if (scan && (scan.keys.length || scan.daemons.length)) {
    console.log(C.dim("\n  Detected providers:"));
    for (const k of scan.keys) {
      const dot = C.ok("o");
      const name = k.label.padEnd(TOOL_COL);
      const masked = C.dim(`${maskKey(k.value)}  (${k.source})`);
      console.log(`   ${dot} ${name} ${masked}`);
    }
    for (const d of scan.daemons) {
      const dot = C.ok("o");
      const name = d.label.padEnd(TOOL_COL);
      console.log(`   ${dot} ${name} ${C.dim("local daemon detected")}`);
    }
  }

  const summary = [
    `docker: ${docker.found ? docker.version : "MISSING -- required"}`,
    `docker compose: ${compose.found ? "ok" : "MISSING -- required"}`,
    ...conns.map((c) => `${c.label.split(" -- ")[0]}: ${c.found ? c.version || "found" : "not installed"}`),
    `tailscale: ${host || "not detected"}`,
  ].join("\n");
  return { docker, compose, host, summary };
}

/** List models with a (recommended) marker; user picks a number, a name, or Enter. */
async function chooseModel(rl, label, options, recommended) {
  if (!options.length) return recommended || "";
  console.log(C.b(`\n  ${label}\n`));
  options.forEach((m, i) => {
    console.log(`   ${C.dim(`${i + 1})`)} ${m}${m === recommended ? C.ok("   < recommended") : ""}`);
  });
  const a = (await rl.question(
    `   pick a number${recommended ? `, or Enter for ${C.dim(recommended)}` : ", or type a name"}: `
  )).trim();
  if (!a) return recommended || options[0];
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  return a;
}

// The four providers shown by default in the key-entry prompts (everyone else
// is behind the "more providers" option so first-timers aren't overwhelmed).
const PRIMARY_PROVIDER_IDS = new Set(["anthropic", "openai", "google", "openrouter"]);

/**
 * Connector-driven provider auth. For each installed CLI (gemini/codex):
 * offer to run the account login AND/OR paste an API key, storing BOTH when
 * given (the later model picker can use either). API keys feed the LiteLLM
 * gateway directly and are collected via the declarative API_PROVIDERS registry.
 * Claude CLI is handled in its own opt-in step.
 *
 * scan: result of scanProviders() -- detected keys are presented up-front for
 * a one-shot accept; individual prompts only when the user declines the batch.
 */
async function setupProviders(rl, ask, v, seed, scan = null) {
  for (const conn of CONNECTORS.filter((c) => c.kind === "cli" && c.id !== "claude-code")) {
    const installed = detectBin(conn.bin).found;
    const name = conn.label.split(" -- ")[0];
    const status = installed ? C.ok("installed") : C.dim("not installed");
    const defYes = installed || conn.required;
    const ans = (await rl.question(`\n   ${C.b(name)} ${C.dim("(" + status + ")")} -- set up? ${C.dim(defYes ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
    const want = ans ? ans === "y" || ans === "yes" : defYes;
    if (!want) continue;

    // login -- run the account login flow
    if (conn.login && installed) {
      const lg = (await rl.question(`     Log in via \`${conn.login.cmd}\` now? ${C.dim("[y/N]")}: `)).trim().toLowerCase();
      if (lg === "y" || lg === "yes") {
        try {
          execSync(conn.login.cmd, { stdio: "inherit" });
        } catch (e) {
          console.log(C.warn("     login command exited non-zero -- paste a token/key below instead. (" + (e?.message || e) + ")"));
        }
        if (conn.login.capture && conn.login.env) {
          const tok = await ask(`     paste the token it printed (Enter to skip)`, seed[conn.login.env]);
          if (tok) v[conn.login.env] = tok;
        } else {
          console.log(C.dim(`     (${conn.login.note})`));
        }
      } else if (conn.login.capture && conn.login.env && seed[conn.login.env]) {
        v[conn.login.env] = seed[conn.login.env]; // keep a prior token on re-run
      }
    } else if (conn.login?.capture && conn.login.env) {
      // CLI missing but they may already hold a token
      const tok = await ask(`     ${conn.login.env} ${C.dim("(Enter to skip)")}`, seed[conn.login.env]);
      if (tok) v[conn.login.env] = tok;
    }

    // api key -- always portable into the container
    if (conn.apikey) {
      const key = await ask(`     ${conn.apikey.env} ${C.dim("(Enter to skip)")}`, seed[conn.apikey.env]);
      if (key) v[conn.apikey.env] = key;
    }
  }

  await setupApiKeys(rl, ask, v, seed, scan);
}

/**
 * Registry-driven API key collection: one-shot accept of scanned keys, then
 * prompts for missing primary providers, with the long tail behind "more".
 */
async function setupApiKeys(rl, ask, v, seed, scan) {
  // 1. Detected keys (from shell env + prior install): one-shot accept/decline.
  const detected = scan?.keys ?? [];
  if (detected.length) {
    console.log(C.dim("\n  Detected provider keys:"));
    for (const k of detected) {
      console.log(`   ${C.ok("o")} ${k.label.padEnd(14)} ${k.envVar}=${C.dim(maskKey(k.value))}  ${C.dim("(" + k.source + ")")}`);
    }
    const useAll = (await rl.question(`\n   Use these detected keys? ${C.dim("[Y/n]")}: `)).trim().toLowerCase();
    if (!useAll || useAll === "y" || useAll === "yes") {
      for (const k of detected) v[k.envVar] = k.value;
    } else {
      // Per-key confirm.
      for (const k of detected) {
        const keep = (await rl.question(`   Use ${k.envVar} (${maskKey(k.value)})? ${C.dim("[Y/n]")}: `)).trim().toLowerCase();
        if (!keep || keep === "y" || keep === "yes") v[k.envVar] = k.value;
      }
    }
  }

  // 2. Keys not already set: prompt for primary providers, offer "more" for the rest.
  const alreadySet = new Set(detected.map((k) => k.provider));
  // Also mark providers whose CLI already set the key (gemini-cli / codex-cli).
  for (const p of API_PROVIDERS) {
    if (v[p.envVars[0]]) alreadySet.add(p.id);
  }

  const notSet = API_PROVIDERS.filter((p) => !alreadySet.has(p.id));
  const primaryMissing = notSet.filter((p) => PRIMARY_PROVIDER_IDS.has(p.id));
  const secondaryMissing = notSet.filter((p) => !PRIMARY_PROVIDER_IDS.has(p.id));

  if (primaryMissing.length) {
    console.log(C.dim("\n  Provider API keys (optional -- Enter to skip each):"));
    for (const p of primaryMissing) {
      const envVar = p.envVars[0];
      const key = await ask(`   ${p.label} ${envVar} ${C.dim(`(${p.signupUrl})`)}`, seed[envVar] ?? "");
      if (key) v[envVar] = key;
    }
  }

  if (secondaryMissing.length) {
    const more = (await rl.question(`   Enter keys for more providers (${secondaryMissing.map((p) => p.label).join(", ")})? ${C.dim("[y/N]")}: `)).trim().toLowerCase();
    if (more === "y" || more === "yes") {
      for (const p of secondaryMissing) {
        const envVar = p.envVars[0];
        const key = await ask(`   ${p.label} ${envVar} ${C.dim(`(${p.signupUrl})`)}`, seed[envVar] ?? "");
        if (key) v[envVar] = key;
      }
    }
  }
}

// ---- brain model (the ONE model Spectre thinks with) ------------------------

// Derived map: litellmPrefix -> canonical envVar (built once from the registry).
const _prefixToEnvVar = Object.fromEntries(
  API_PROVIDERS.map((p) => [p.litellmPrefix, p.envVars[0]])
);

/** Conventional env var holding the API key for a litellm model's provider.
 *  Derived from API_PROVIDERS (litellmPrefix -> canonical envVar); azure has
 *  no registry entry and keeps a hard-coded fallback. */
function brainKeyEnv(model) {
  const prefix = String(model).split("/")[0];
  if (prefix === "azure") return "AZURE_API_KEY";
  return _prefixToEnvVar[prefix] || "SPECTRE_BRAIN_API_KEY";
}

/**
 * Rewrite litellm-config.yaml's `spectre-default` entry to point at the chosen
 * backing model. spec = { model, api_base?, api_key_env? }. Returns false if the
 * config file is missing. This is what "remembers" the configured brain -- the
 * core always requests the friendly id `spectre-default`, which this entry fronts.
 */
export function setBrainModelYaml(spec, configPath = join(ROOT, "litellm-config.yaml")) {
  if (!existsSync(configPath)) return false;
  let text = readFileSync(configPath, "utf8");
  const lines = ["  - model_name: spectre-default", "    litellm_params:", `      model: ${spec.model}`];
  if (spec.api_base) lines.push(`      api_base: ${spec.api_base}`);
  if (spec.api_key_env) lines.push(`      api_key: os.environ/${spec.api_key_env}`);
  const block = lines.join("\n");
  // Replace the existing spectre-default entry (its 4/6-space indented body) in place.
  const re = /^ {2}- model_name: spectre-default\n(?: {4}.*\n| {6}.*\n)*/m;
  text = re.test(text) ? text.replace(re, block + "\n") : text.replace(/^model_list:\n/m, `model_list:\n${block}\n`);
  writeFileSync(configPath, text);
  return true;
}

/**
 * Pick the ONE model Spectre reasons + uses tools with, and persist it into
 * litellm-config.yaml's `spectre-default`. A local Ollama model (no keys), a
 * fresh pull, or a hosted API model. Additional models are added later in
 * Settings -> Providers; this just sets the default the core requests.
 */
async function setupBrainModel(rl, ask, v, chatModels, guide, dryRun) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Brain model (the ONE Spectre thinks with)"));
  console.log(C.dim("   What Spectre reasons + calls tools with."));
  console.log(C.dim("   Add or switch more later in Settings -> Providers."));
  await guide?.narrate(
    "Now the brain model -- the ONE model Spectre thinks and uses tools with. " +
    "A local Ollama model needs no keys; or bring a hosted API model via a key. " +
    "Only one is set now; more get added in Settings.",
  );

  const opts = chatModels.map((m) => ({ label: `${m}  ${C.dim("(local Ollama)")}`, kind: "ollama", id: m }));
  opts.push({ label: "pull a local Ollama model", kind: "pull" });
  opts.push({ label: "an API model (provider id + key)", kind: "api" });
  opts.forEach((o, i) => console.log(`   ${C.dim(`${i + 1})`)} ${o.label}${i === 0 ? C.ok("   < recommended") : ""}`));
  const pick = (await ask(`Brain model [1-${opts.length}]`, "1")).trim();
  const idx = Number(pick) - 1;
  const choice = Number.isInteger(idx) && opts[idx] ? opts[idx] : opts[0];

  let spec;
  if (choice.kind === "api") {
    const model = await ask("Provider model id (e.g. anthropic/claude-sonnet-4-6)", "anthropic/claude-sonnet-4-6");
    const keyEnv = await ask("Env var holding its API key", brainKeyEnv(model));
    if (!v[keyEnv]) {
      const key = await ask(`${keyEnv} ${C.dim("(Enter if already set above)")}`, "");
      if (key) v[keyEnv] = key;
    }
    spec = { model, api_key_env: keyEnv };
  } else {
    let name = choice.id;
    if (choice.kind === "pull") {
      name = (await ask("Ollama model to pull", "qwen2.5:7b-instruct")).trim() || "qwen2.5:7b-instruct";
      if (!dryRun) {
        if (!detectBin("ollama").found) {
          console.log(C.warn("   Ollama isn't installed (https://ollama.com/download) -- install it and pull the model later; it'll be used on next start."));
        } else {
          try {
            execSync(`ollama pull ${name}`, { stdio: "inherit" });
          } catch {
            console.log(C.warn("   pull failed -- you can pull it later and it'll be used on next start."));
          }
        }
      }
    }
    spec = { model: `ollama_chat/${name}`, api_base: "http://host.docker.internal:11434" };
  }

  v.SPECTRE_LITELLM_MODEL = "spectre-default"; // friendly id; the backing model lives in the yaml
  if (dryRun) {
    console.log(C.dim(`   --dry-run: would set spectre-default -> ${spec.model}`));
  } else {
    const set = setBrainModelYaml(spec);
    console.log(
      set
        ? C.ok(`   + brain model set: ${C.b(spec.model)}`) +
            C.dim("  (litellm-config.yaml - spectre-default - change/add anytime in Settings)")
        : C.warn("   ! litellm-config.yaml not found -- set the spectre-default entry manually."),
    );
  }
  await guide?.narrate(
    `The user set ${spec.model} as Spectre's brain. Reassure them it's saved and that more models are added anytime in Settings.`,
  );
}

// ---- install profile / channels / tailnet -----------------------------------

const PROFILES = {
  headless: { label: "Headless", profiles: "", blurb: "core + channels + API only -- no web UI. Talk via Telegram/WhatsApp/Discord + the API." },
  standard: { label: "Standard", profiles: "ui", blurb: "the web app + core modules (chat, memory, monitor, settings). The default." },
  full: { label: "Full", profiles: "ui,workspace", blurb: "everything: web app + Tempus + the Workspaces code IDE." },
};

/** Pick what runs: Headless / Standard / Full -> the compose profiles string. */
async function chooseProfile(ask, guide) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Install profile"));
  for (const p of Object.values(PROFILES)) {
    console.log(`   ${C.b(p.label.padEnd(9))} ${C.dim("-- " + p.blurb)}`);
  }
  await guide?.narrate(
    "Choose an install profile: Headless (no UI -- channels + API only, great for a server-side bot), " +
    "Standard (the web app + core modules), or Full (adds Tempus + the Workspaces code IDE). " +
    "Recommend Standard for most.",
  );
  const ans = (await ask("Profile: [H]eadless / [S]tandard / [F]ull?", "S")).toLowerCase();
  const profile = ans.startsWith("h") ? "headless" : ans.startsWith("f") ? "full" : "standard";
  console.log(C.ok(`   + ${PROFILES[profile].label}`));
  return { profile, composeProfiles: PROFILES[profile].profiles };
}

/** Collect tokens for the channels the user enables (default-deny allowlists). */
async function setupChannels(ask, v, seed, guide) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Messaging channels (optional)"));
  console.log(C.dim("   Reach Spectre from your phone."));
  console.log(C.dim("   Each is DEFAULT-DENY -- you allowlist who can talk to it."));
  await guide?.narrate(
    "Optional messaging channels -- Telegram, WhatsApp, Discord. Each needs a bot token " +
    "and an allowed-sender list, and is default-deny. They can skip any and add it later in .env.docker.",
  );
  const yes = (a) => a.toLowerCase().startsWith("y");

  if (yes(await ask("  ? Enable Telegram? [y/N]", seed.TELEGRAM_BOT_TOKEN ? "Y" : "N"))) {
    v.TELEGRAM_BOT_TOKEN = await ask("  Bot token (@BotFather)", seed.TELEGRAM_BOT_TOKEN);
    v.TELEGRAM_WEBHOOK_SECRET = seed.TELEGRAM_WEBHOOK_SECRET || genHex(16);
    v.TELEGRAM_ALLOWED_SENDER_IDS = await ask("  Allowed user IDs (comma-sep)", seed.TELEGRAM_ALLOWED_SENDER_IDS);
    console.log(C.dim(
      "   Point Telegram at https://<host>/api/channels/telegram/webhook" +
      " (secret auto-generated; see .env.docker.example)."
    ));
  }
  if (yes(await ask("  ? Enable WhatsApp? [y/N]", seed.WHATSAPP_TOKEN ? "Y" : "N"))) {
    v.WHATSAPP_TOKEN = await ask("  Access token", seed.WHATSAPP_TOKEN);
    v.WHATSAPP_PHONE_NUMBER_ID = await ask("  Phone number ID", seed.WHATSAPP_PHONE_NUMBER_ID);
    v.WHATSAPP_VERIFY_TOKEN = seed.WHATSAPP_VERIFY_TOKEN || genHex(16);
    v.WHATSAPP_APP_SECRET = await ask("  App secret (signature verify)", seed.WHATSAPP_APP_SECRET);
    v.WHATSAPP_ALLOWED_SENDER_IDS = await ask("  Allowed sender numbers (comma-sep, digits)", seed.WHATSAPP_ALLOWED_SENDER_IDS);
  }
  if (yes(await ask("  ? Enable Discord? [y/N]", seed.DISCORD_BOT_TOKEN ? "Y" : "N"))) {
    v.DISCORD_BOT_TOKEN = await ask("  Bot token", seed.DISCORD_BOT_TOKEN);
    v.DISCORD_ALLOWED_SENDER_IDS = await ask("  Allowed user IDs (comma-sep)", seed.DISCORD_ALLOWED_SENDER_IDS);
  }
}

/**
 * On Windows, Docker Desktop runs the whole stack inside the WSL2 VM, which
 * uncapped claims ~50% of host RAM and -- without autoMemoryReclaim -- never
 * hands page-cache-bloated pages back (one big image pull balloons vmmem by
 * gigabytes and it stays there). Offer a ~/.wslconfig budget once. If a
 * .wslconfig already exists we only PRINT the suggested block -- appending
 * section headers to a user-managed file risks duplicate-section surprises.
 */
async function offerWslMemoryCap(ask) {
  if (process.platform !== "win32") return;
  const cfgPath = join(homedir(), ".wslconfig");
  let existing = "";
  try { existing = readFileSync(cfgPath, "utf8"); } catch { /* no file yet */ }
  if (/^\s*memory\s*=/m.test(existing)) return; // already budgeted

  const totalGb = Math.round(totalmem() / 1024 ** 3);
  const capGb = Math.max(4, Math.min(12, Math.round(totalGb / 2)));
  const block = [
    "[wsl2]",
    "# Cap the WSL2 VM (Docker Desktop included) -- written by the Spectre installer.",
    `memory=${capGb}GB`,
    "",
    "[experimental]",
    "# Hand idle page-cache memory back to Windows instead of sitting on it.",
    "autoMemoryReclaim=gradual",
    "",
  ].join("\n");

  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  WSL memory budget"));
  console.log(C.dim(`   Docker Desktop runs in the WSL2 VM. Uncapped it can claim about half of`));
  console.log(C.dim(`   your ${totalGb} GB RAM and never give it back (the giant-vmmem symptom).`));
  if (existing) {
    console.log(C.warn("   ! You already have a ~/.wslconfig (without a memory cap). Suggested block:"));
    console.log(C.dim(block.split("\n").map((l) => "     " + l).join("\n")));
    console.log(C.dim("   Merge it by hand, then run `wsl --shutdown` to apply."));
    return;
  }
  const yn = (await ask(`  ? Cap WSL at ${capGb} GB + enable memory reclaim (writes ~/.wslconfig)? [Y/n]`, "Y")).toLowerCase();
  if (yn && yn !== "y" && yn !== "yes") return;
  writeFileSync(cfgPath, block);
  console.log(C.ok(`   + wrote ${cfgPath}`));
  console.log(C.warn("   ! Takes effect after `wsl --shutdown` -- run that AFTER this install finishes"));
  console.log(C.warn("     (it restarts Docker Desktop and everything else in WSL)."));
}

/** Offer to expose the shell over Tailscale HTTPS (needed for the Secure cookie). */
async function guidedTailscale(ask, port, guide) {
  const host = tailnetHost();
  if (!host) {
    console.log(C.dim(
      "   Tailscale not detected -- install it and run `tailscale up` to join your tailnet,"
    ));
    console.log(C.dim(
      "   then: tailscale serve --bg https / http://127.0.0.1:" + port
    ));
    console.log(C.dim(
      "   This puts Spectre at https://<host>.<tailnet>.ts.net with real HTTPS, so the"
    ));
    console.log(C.dim(
      "   Secure session cookie works and you can reach it from your phone."
    ));
    return;
  }
  console.log(C.ok("   o tailscale: ") + C.dim(host));
  console.log(C.dim(
    "   `tailscale serve` puts Spectre at https://" + host + " on your tailnet."
  ));
  console.log(C.dim(
    "   HTTPS is required -- over plain HTTP the Secure session cookie is dropped and PIN login loops."
  ));
  console.log(C.dim(
    "   If the command below fails, run `tailscale up` first, then rerun it manually:"
  ));
  console.log(C.dim(
    "     tailscale serve --bg https / http://127.0.0.1:" + port
  ));
  await guide?.narrate(
    "Tailscale is here. Running `tailscale serve` puts Spectre behind HTTPS on the tailnet -- " +
    "required for the secure login cookie and for reaching it from a phone. Offer to set it up now.",
  );
  if ((await ask("  ? Serve over Tailscale HTTPS now? [Y/n]", "Y")).toLowerCase().startsWith("n")) return;
  const cmd = `tailscale serve --bg https / http://127.0.0.1:${port}`;
  console.log(C.dim("   Running: " + cmd));
  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(C.ok("   + serving over Tailscale") + C.dim(` -> https://${host}`));
  } catch (e) {
    console.log(C.warn("   ! tailscale serve failed -- run it yourself: " + cmd + " (" + (e?.message || e) + ")"));
  }
}

// ---- uninstall --------------------------------------------------------------

/**
 * Stop and remove Spectre's containers + networks. Named volumes (data) are
 * kept by default; pass --purge (or answer yes to the interactive prompt) to
 * also delete volumes + .env files.
 *
 * Mirrors the compose argv construction used in the install path -- reuses the
 * same env-file + -f flags so compose resolves the right project.
 */
async function runUninstall(args) {
  // Print a plain uninstall header (same style as non-TTY banner).
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
    for (const [code, tmpl] of BANNER_ROWS) {
      process.stdout.write(C.p(code, tmpl.replace(/#/g, FB)) + "\n");
    }
    process.stdout.write("\n");
  } else {
    console.log("\n  S P E C T R E  --  uninstall\n");
  }
  console.log(C.b("  Spectre uninstall"));
  console.log(C.dim("  " + "-".repeat(56)));

  // Check docker is available -- if not, say so and exit cleanly.
  const { docker, compose } = detectDocker();
  if (!docker.found || !compose.found) {
    console.log(C.warn(
      "\n  Docker not found -- nothing to stop. If Spectre was running in Docker,\n" +
      "  install Docker first and then run: docker compose down --remove-orphans\n"
    ));
    process.exit(0);
  }

  // Detect which compose files exist.
  const mainCompose = join(ROOT, "docker-compose.yml");
  const localDbCompose = join(ROOT, "local-db", "docker-compose.yml");
  const hasLocalDb = existsSync(localDbCompose);

  console.log(C.dim("\n  Compose files:"));
  console.log(C.dim("    " + mainCompose));
  if (hasLocalDb) console.log(C.dim("    " + localDbCompose));

  const hasPurge = args.has("--purge");
  const hasYes = args.has("--yes");

  // Confirmation gate (destructive).
  if (!hasYes) {
    if (!stdin.isTTY) {
      console.log(C.err(
        "\n  Non-interactive context -- pass --yes to confirm uninstall without a prompt.\n" +
        "  Example: node installer/install.mjs --uninstall --yes\n"
      ));
      process.exit(1);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question(
      `\n   Stop and remove Spectre's containers + networks? ${C.dim("[y/N]")}: `
    )).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.log(C.dim("  Aborted.\n"));
      process.exit(0);
    }
  }

  // Optional --purge: interactive confirmation when not passed as a flag.
  // Only prompt when running fully interactively (no --yes, real TTY).
  let doPurge = hasPurge;
  if (!doPurge && !hasYes && stdin.isTTY) {
    // Already closed the first rl above -- open a new one.
    const rl2 = createInterface({ input: stdin, output: stdout });
    const ans2 = (await rl2.question(
      `\n   Also DELETE all data + secrets (database volumes, .env.docker, local-db/.env)?\n` +
      `   ${C.warn("This is IRREVERSIBLE.")} ${C.dim("[y/N]")}: `
    )).trim().toLowerCase();
    rl2.close();
    doPurge = ans2 === "y" || ans2 === "yes";
  }

  if (doPurge) {
    console.log(C.warn(
      "\n  ! PURGE -- deleting named volumes and .env files. This cannot be undone."
    ));
  }

  // Build the same compose argv the installer uses (env-file only -- profiles
  // aren't needed for `down` since compose down stops all services regardless).
  // The main .env.docker may not exist if the install never completed; that's fine
  // for `down` (compose just won't find env subs, but down still works).
  const envFileArgs = existsSync(ENV_PATH) ? ["--env-file", ".env.docker"] : [];

  const removed = [];
  const kept = [];

  // Helper: run `docker compose ... down [flags]` for a given set of compose args.
  async function composeDown(composeArgv, label, extraFlags = []) {
    const argv = [...composeArgv, "down", "--remove-orphans", ...extraFlags];
    console.log(C.dim("\n  Running: docker compose " + argv.join(" ")));
    const res = await spawnCollect("docker", ["compose", ...argv], { cwd: ROOT });
    if (res.code !== 0) {
      // A non-zero exit here usually just means "no containers running" -- not a crash.
      const msg = (res.stderr || res.stdout).trim().split("\n")[0];
      console.log(C.warn(`  ! ${label}: compose down reported an error -- ${msg || "check docker compose logs"}`));
    } else {
      console.log(C.ok(`  + ${label}: containers stopped and removed`));
    }
  }

  // ---- main stack ------------------------------------------------------------
  const mainArgv = [...envFileArgs, "-f", "docker-compose.yml"];
  await composeDown(mainArgv, "main stack");
  removed.push("main stack containers + networks");

  if (doPurge) {
    await composeDown(mainArgv, "main stack (volumes)", ["-v"]);
    removed.push("main stack named volumes");
  } else {
    kept.push("main stack named volumes (your data)");
  }

  // ---- local-db stack --------------------------------------------------------
  if (hasLocalDb) {
    const localEnvArgs = existsSync(join(ROOT, "local-db", ".env"))
      ? ["--env-file", "local-db/.env"]
      : [];
    const localArgv = [...localEnvArgs, "-f", "local-db/docker-compose.yml"];
    await composeDown(localArgv, "local-db stack");
    removed.push("local-db containers + networks");

    if (doPurge) {
      await composeDown(localArgv, "local-db stack (volumes)", ["-v"]);
      removed.push("local-db named volumes");
    } else {
      kept.push("local-db named volumes (your database)");
    }
  }

  // ---- .env files (purge only) -----------------------------------------------
  if (doPurge) {
    for (const p of [ENV_PATH, join(ROOT, "local-db", ".env")]) {
      if (existsSync(p)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(p);
        console.log(C.warn("  ! deleted " + p));
        removed.push(p);
      }
    }
  } else {
    kept.push(".env.docker (your secrets -- kept for reinstall)");
    if (hasLocalDb && existsSync(join(ROOT, "local-db", ".env")))
      kept.push("local-db/.env");
  }

  // ---- summary ---------------------------------------------------------------
  console.log("\n" + C.dim("  " + "-".repeat(56)));
  if (removed.length) {
    console.log(C.b("  Removed:"));
    for (const r of removed) console.log(C.ok("    - ") + C.dim(r));
  }
  if (kept.length) {
    console.log(C.b("  Kept:"));
    for (const k of kept) console.log(C.dim("    - " + k));
  }
  if (!doPurge) {
    console.log(
      "\n" + C.dim("  To fully purge all data + secrets, run:") +
      "\n" + C.dim("    node installer/install.mjs --uninstall --purge")
    );
  }
  console.log("");
  process.exit(0);
}

// The services that run the locally-built core image. `core` carries the build:
// context; the rest reuse its tag, so rebuilding `core` refreshes all of them.
const CORE_IMAGE_SERVICES = ["core", "chat-runner", "scheduler", "channel-runner"];

/**
 * On a re-run (an existing .env.docker), offer manage actions instead of silently
 * walking the full setup again. Returns one of:
 *   "update-core" | "update-shell" | "update-both" | "reconfigure" | "uninstall" | "quit"
 */
async function chooseExistingAction(askRaw, seed) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Existing Spectre install detected"));
  console.log(C.dim(`   ${ROOT}`));
  console.log(C.dim(`   profiles: ${seed.COMPOSE_PROFILES || "(headless)"}`));
  console.log("");
  console.log(`   ${C.b("1")}) Update core        ${C.dim("-- rebuild the brain from the current source + restart it")}`);
  console.log(`   ${C.b("2")}) Update shell       ${C.dim("-- rebuild the web UI from the current source")}`);
  console.log(`   ${C.b("3")}) Update both`);
  console.log(`   ${C.b("4")}) Reconfigure        ${C.dim("-- re-run the full setup (keeps your settings as defaults)")}`);
  console.log(`   ${C.b("5")}) Uninstall          ${C.dim("-- stop + remove Spectre (option to delete data)")}`);
  console.log(`   ${C.b("6")}) Quit`);
  const map = { 1: "update-core", 2: "update-shell", 3: "update-both", 4: "reconfigure", 5: "uninstall", 6: "quit" };
  const a = (await askRaw("  ? Choose [1-6]", "6")).trim();
  return map[a] || "quit";
}

/** docker compose argv prefix for a manage action: env-file + the install's profiles. */
function manageComposeArgs(seed) {
  const envArgs = existsSync(ENV_PATH) ? ["--env-file", ".env.docker"] : [];
  // ?? not || : a headless install has COMPOSE_PROFILES="" (present + empty) and
  // must stay profile-less; only a truly absent key falls back to "ui".
  const profileArgs = (seed.COMPOSE_PROFILES ?? "ui")
    .split(",").map((s) => s.trim()).filter(Boolean).flatMap((p) => ["--profile", p]);
  return [...envArgs, ...profileArgs];
}

/** The git SHA to stamp images with (baked as SPECTRE_BUILD_SHA so the running
 *  core can detect when origin/main has moved on). Fail-soft to "". */
function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Rebuild the core from source (./core) and recreate the services that run it. */
function updateCoreImage(seed) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Updating the core"));
  console.log(C.dim("   (the one-line installer fetches the newest source first; running this"));
  console.log(C.dim("    directly rebuilds whatever source is on disk now.)"));
  const base = ["docker", "compose", ...manageComposeArgs(seed)];
  try {
    console.log(C.dim("   Rebuilding the brain from source + restarting it..."));
    // `core` carries the build: context; --build recompiles it and the runner
    // services reuse the freshly built spectre-core:local tag.
    execSync([...base, "up", "-d", "--build", ...CORE_IMAGE_SERVICES].join(" "), { cwd: ROOT, stdio: "inherit", env: { ...process.env, SPECTRE_BUILD_SHA: gitSha() } });
    console.log(C.ok("\n  + core updated"));
  } catch (e) {
    console.log(C.err("\n  x core update failed -- ") + C.dim(String(e?.message || e).split("\n")[0]));
  }
}

/** Rebuild the shell image from the current source and recreate it. */
function updateShell(seed) {
  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Updating the shell"));
  if (!(seed.COMPOSE_PROFILES ?? "ui").includes("ui")) {
    console.log(C.warn("   This is a headless install (no shell) -- nothing to rebuild."));
    return;
  }
  console.log(C.dim("   Rebuilding the web UI + recreating it..."));
  console.log(C.dim("   (the one-line installer fetches the newest source first; running this"));
  console.log(C.dim("    directly rebuilds whatever source is on disk now.)"));
  const base = ["docker", "compose", ...manageComposeArgs(seed)];
  try {
    execSync([...base, "up", "-d", "--build", "shell"].join(" "), { cwd: ROOT, stdio: "inherit", env: { ...process.env, SPECTRE_BUILD_SHA: gitSha() } });
    console.log(C.ok("\n  + shell updated"));
  } catch (e) {
    console.log(C.err("\n  x shell update failed -- ") + C.dim(String(e?.message || e).split("\n")[0]));
  }
}

/**
 * Manage-menu dispatch for a re-run. Returns true when the chosen action is
 * terminal (caller should stop), or false to fall through to the full
 * reconfigure wizard.
 */
async function handleExistingInstall(rl, askRaw, seed) {
  const action = await chooseExistingAction(askRaw, seed);
  if (action === "reconfigure") return false;
  rl.close();
  if (action === "uninstall") {
    await runUninstall(new Set()); // interactive confirm + optional purge; exits
  } else if (action !== "quit") {
    if (action === "update-core" || action === "update-both") updateCoreImage(seed);
    if (action === "update-shell" || action === "update-both") updateShell(seed);
    console.log(C.dim("\n  Done. Re-run this installer anytime to update or reconfigure.\n"));
  }
  return true;
}

// ---- the wizard -------------------------------------------------------------

// Total phase count (kept in one place so numbering stays consistent).
const TOTAL_PHASES = 7;

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const checkOnly = args.has("--check");

  // Uninstall path -- runs INSTEAD of the install wizard; exits when done.
  if (args.has("--uninstall")) {
    await runUninstall(args);
    return; // runUninstall calls process.exit -- belt-and-suspenders
  }

  // Seed from an existing .env.docker on re-run; else from blanks.
  // Loaded early so scanProviders can check it before the report is printed.
  const firstInstall = !existsSync(ENV_PATH); // gate the port preflight (re-runs reuse Spectre's own ports)
  const seed = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};

  // Scan shell env + seed for provider keys; probe local daemons. Done before
  // the Phase-1 report so detected keys appear in the environment table.
  const scan = await scanProviders(seed);

  // Phase 1: environment report.
  // Non-TTY (--check, pipe): just print banner + report without clearing.
  if (process.stdout.isTTY && !checkOnly) {
    phase(1, TOTAL_PHASES, "environment");
  } else {
    printBanner();
    console.log(C.dim("  open-core - your machine - your models\n"));
  }

  const env = report(scan);

  if (checkOnly) return;

  if (!env.docker.found || !env.compose.found) {
    console.log(C.err("\n  Docker with Compose v2 is required."));
    console.log(C.dim("   - Linux:      Docker Engine + the compose plugin"));
    console.log(C.dim("                 https://docs.docker.com/engine/install/"));
    console.log(C.dim("   - Mac/Windows: Docker Desktop"));
    console.log(C.dim("                 https://www.docker.com/products/docker-desktop/"));
    console.log(C.dim("   (only `docker` + `docker compose` on PATH are needed -- Desktop not required)\n"));
    if (!dryRun) process.exit(1);
  }

  // Interactive-only: the wizard + sub-logins read from a real TTY. Fail fast with
  // a clear message instead of hanging when piped / run in CI (use --check/--dry-run).
  if (!dryRun && !checkOnly && !stdin.isTTY) {
    console.log(C.err("\n  This installer is interactive -- run it in a terminal (not piped/CI)."));
    console.log(C.dim("  For a non-interactive preview use:  node installer/install.mjs --dry-run\n"));
    process.exit(1);
  }

  // Linux + local Ollama: the default systemd service binds 127.0.0.1, which a
  // container can't reach via host.docker.internal (that arrives on the bridge IP).
  if (process.platform === "linux") {
    console.log(C.dim(
      "\n  Linux note: if you use the local Ollama brain, bind it to 0.0.0.0 so\n" +
      "  containers can reach it:\n" +
      "    sudo systemctl edit ollama\n" +
      "    Environment=\"OLLAMA_HOST=0.0.0.0:11434\"\n" +
      "    then restart. Otherwise chat/embeddings time out.",
    ));
  }

  const rl = createInterface({ input: stdin, output: stdout });

  // Local Ollama models the user has -- drive both the setup-guide pick and the
  // runtime-model pick below. Fetched once. null = the daemon isn't running.
  const ollama = dryRun ? null : await ollamaModels();
  const chatModels = (ollama ?? []).filter((m) => !/embed/i.test(m));

  // Conversational guide (optional): an installed CLI (Claude/Gemini/Codex) OR a
  // local Ollama model narrates each step + answers questions -- type `?question`
  // at any prompt. Advisory only; the wizard does every real action. The user
  // PICKS which backend guides them, can pull an Ollama model, or skips. Silent
  // with --no-guide. The narrator is a LOCAL/personal install aid only; it does
  // NOT make the SHIPPED brain use a subscription (that stays provider-agnostic).
  const askRaw = async (q, def = "") =>
    (await rl.question(`   ${q}${def ? C.dim(` [${def}]`) : ""}: `)).trim() || def;

  // Re-run on an existing install: offer manage actions (update / reconfigure /
  // uninstall) instead of silently restarting first-time setup.
  if (!firstInstall && !dryRun && (await handleExistingInstall(rl, askRaw, seed))) return;

  let guide = null;
  if (!dryRun && !args.has("--no-guide")) {
    guide = await chooseNarrator(rl, askRaw);
    if (guide) {
      console.log();
      await guide.detected(env.summary);
      console.log(C.dim("\n   (tip: type `?` + a question at any prompt to ask the guide.)"));
    }
  }

  const ask = async (q, def = "") => {
    for (;;) {
      const a = (await rl.question(`   ${q}${def ? C.dim(` [${def}]`) : ""}: `)).trim();
      if (a.startsWith("?")) {
        if (guide) await guide.answer(a.slice(1).trim() || q);
        else console.log(C.dim("   (the guide isn't active -- see docs/M6-INSTALLER.md)"));
        continue;
      }
      return a || def;
    }
  };

  let wantClaude = false;
  let useLocalDb = false;
  let composeProfiles = seed.COMPOSE_PROFILES ?? "ui";
  let profile = "standard";
  let v;
  if (dryRun) {
    console.log(C.dim("\n  --dry-run: using example/seed values, writing nothing, no docker.\n"));
    wantClaude = seed.SPECTRE_ALLOW_CLAUDE_CLI === "1";
    v = {
      NEXT_PUBLIC_SUPABASE_URL: seed.NEXT_PUBLIC_SUPABASE_URL || "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: seed.SUPABASE_SERVICE_ROLE_KEY || "service-example",
      CLAUDE_CODE_OAUTH_TOKEN: wantClaude ? seed.CLAUDE_CODE_OAUTH_TOKEN || "claude-token-example" : "",
      CORE_TOKEN: seed.CORE_TOKEN || genHex(),
      SESSION_SECRET: seed.SESSION_SECRET || genHex(),
      LITELLM_MASTER_KEY: seed.LITELLM_MASTER_KEY || genHex(),
      SPECTRE_SERVICE_TOKEN: seed.SPECTRE_SERVICE_TOKEN || genHex(),
      WORKSPACE_SERVICE_TOKEN: seed.WORKSPACE_SERVICE_TOKEN || genHex(),
      UPDATER_TOKEN: seed.UPDATER_TOKEN || genHex(),
      CODE_SERVER_PASSWORD: seed.CODE_SERVER_PASSWORD || genHex(16),
      GH_TOKEN: seed.GH_TOKEN ?? "",
      WORKSPACE_TRUSTED_DIRS: seed.WORKSPACE_TRUSTED_DIRS ?? "",
      SPECTRE_ALLOW_CLAUDE_CLI: wantClaude ? "1" : "",
      SPECTRE_ALLOW_CODEX_CLI: seed.SPECTRE_ALLOW_CODEX_CLI ?? "",
      SPECTRE_ALLOW_GEMINI_CLI: seed.SPECTRE_ALLOW_GEMINI_CLI ?? "",
      PIN_HASH: seed.PIN_HASH || pinHash("739281"),
      SHELL_BIND: seed.SHELL_BIND, SHELL_PORT: seed.SHELL_PORT,
      COMPOSE_PROFILES: composeProfiles,
    };
  } else {
    // Phase 2: database choice.
    phase(2, TOTAL_PHASES, "database");
    console.log(C.b("  Database"));
    console.log(C.dim("   Local  -- self-hosted Supabase bundled here. Zero cloud account;"));
    console.log(C.dim("            runs fully on this machine. (default)"));
    console.log(C.dim("   Cloud  -- your own hosted supabase.com project"));
    console.log(C.dim("            (URL + anon + service-role keys)."));
    await guide?.narrate(
      "First the database. The default is a Local self-hosted Supabase the installer bundles and " +
      "starts here -- Postgres, REST and Realtime -- so there's zero cloud account and everything " +
      "runs on this machine. The alternative is the user's own hosted supabase.com project, where " +
      "they'd paste the URL and keys. Recommend Local unless they specifically want cloud."
    );
    const dbChoice = (await ask("  ? Use [L]ocal self-hosted DB or [C]loud Supabase?", "L")).toLowerCase();
    useLocalDb = !(dbChoice === "c" || dbChoice === "cloud");
    if (useLocalDb) {
      console.log("");
      console.log(C.dim("  " + "-".repeat(56)));
      console.log(C.b("  Local database (self-hosted Supabase)"));
      // Keys are generated here so the .env is populated; the actual `up` + schema
      // apply happens AFTER the downloads phase (all images pulled first).
      const { genLocalDbEnv } = await import("./gen-supabase-keys.mjs");
      const keys = genLocalDbEnv();
      console.log(C.ok("   + generated local-db/.env") + C.dim(" (Postgres password + JWT keys)"));
      v = {
        // (No anon key in the main stack: the browser holds no storage
        // credentials -- the local-db stack keeps its own copy in local-db/.env.)
        NEXT_PUBLIC_SUPABASE_URL: "http://localhost:8000", // core fallback URL (host loopback)
        SUPABASE_URL: "http://host.docker.internal:8000", // core/runners (in containers) -> gateway
        SUPABASE_SERVICE_ROLE_KEY: keys.SERVICE_ROLE_KEY,
      };
    } else {
      console.log("");
      console.log(C.dim("  " + "-".repeat(56)));
      console.log(C.b("  Cloud Supabase (your own hosted project)"));
      await guide?.narrate(
        "Collecting the user's hosted Supabase project URL and service-role key -- Spectre's " +
        "storage for chat, memory and config. They grab these at supabase.com -> their project " +
        "-> Settings -> API. No anon key needed: the browser never talks to storage."
      );
      v = {
        NEXT_PUBLIC_SUPABASE_URL: await ask("Supabase URL", seed.NEXT_PUBLIC_SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: await ask("Supabase service role key", seed.SUPABASE_SERVICE_ROLE_KEY),
      };
    }

    // Phase 3: brain model.
    phase(3, TOTAL_PHASES, "brain");
    console.log(C.b("  Providers (the brain)"));
    console.log(C.dim("   Standard brain: the LiteLLM gateway using your own API keys,"));
    console.log(C.dim("   or local Ollama with zero keys."));
    console.log(C.dim("   Provider API keys are optional here; any you enter feed the gateway."));
    await guide?.narrate(
      "Now the AI providers. The standard brain is the LiteLLM gateway running the user's own API keys, " +
      "or local Ollama with zero keys. Provider API keys are optional and feed the gateway; " +
      "Claude CLI is an optional opt-in handled in a separate step."
    );
    await setupProviders(rl, ask, v, seed, scan);

    // The ONE model Spectre thinks with -> written into litellm-config.yaml's
    // `spectre-default` (+ pulled if local). Remembered; more added in Settings.
    await setupBrainModel(rl, ask, v, chatModels, guide, dryRun);

    // Which local models Spectre runs day-to-day (-> .env.docker). Picked from what
    // the user actually has installed, recommended = their gemma3 / nomic-embed.
    if (ollama && ollama.length) {
      console.log("");
      console.log(C.dim("  " + "-".repeat(56)));
      console.log(C.b("  Local models (Ollama)"));
      await guide?.narrate(
        "Now which local models Spectre runs day to day -- a chat model for its dream/learn passes " +
        "and an embeddings model for memory. Suggest keeping gemma3 and nomic-embed-text if installed."
      );
      const embedModels = ollama.filter((m) => /embed/i.test(m));
      if (chatModels.length) {
        const chatRec = chatModels.find((m) => m.startsWith("gemma3")) || chatModels[0];
        const learn = await chooseModel(rl, "Chat / learn model (dream + distill)", chatModels, chatRec);
        v.OLLAMA_LEARN_MODEL = learn;
        v.OLLAMA_DISTILL_MODEL = learn;
      }
      if (embedModels.length) {
        const embedRec = embedModels.find((m) => m.startsWith("nomic-embed-text")) || embedModels[0];
        v.OLLAMA_EMBED_MODEL = await chooseModel(rl, "Embeddings model (memory)", embedModels, embedRec);
      }
    }

    // ---- CLI tool brains (optional) -------------------------------------------
    // Three subscription CLIs can each act as a brain / dispatch target.
    // Each is gated by its own env flag; only Claude needs a special core build.
    const CLI_BRAIN_IDS = ["claude-code", "codex-cli", "gemini-cli"];
    const CLI_GATE_ENV = {
      "claude-code": "SPECTRE_ALLOW_CLAUDE_CLI",
      "codex-cli":   "SPECTRE_ALLOW_CODEX_CLI",
      "gemini-cli":  "SPECTRE_ALLOW_GEMINI_CLI",
    };

    console.log("");
    console.log(C.dim("  " + "-".repeat(56)));
    console.log(C.b("  CLI tool brains (optional)"));
    console.log(C.dim("   Enable any of these as additional brains/dispatch targets."));
    console.log(C.dim("   Each uses your own subscription with that vendor."));
    await guide?.narrate(
      "Optional CLI tool brains -- Claude Code, Codex, or Gemini -- each backed by your own " +
      "subscription with that vendor. All are off by default; the standard LiteLLM gateway " +
      "brain doesn't need any of them. Enable whichever you already subscribe to."
    );

    for (const cliId of CLI_BRAIN_IDS) {
      const conn = CONNECTORS.find((c) => c.id === cliId);
      if (!conn) continue;
      const gateEnv = CLI_GATE_ENV[cliId];
      const name = conn.label.split(" -- ")[0];
      const det = detectBin(conn.bin);
      const statusStr = det.found ? C.ok("installed") + C.dim("  " + (det.version || "")) : C.dim("not installed");
      const ans = (await rl.question(
        `\n   ${C.b(name)}  ${statusStr}\n   Enable as a brain? Uses your own ${name.split(" ")[0]} subscription. ${C.dim("[y/N]")}: `
      )).trim().toLowerCase();
      const want = ans === "y" || ans === "yes";

      if (want) {
        v[gateEnv] = "1";
        if (cliId === "claude-code") wantClaude = true;

        if (det.found && conn.login) {
          try {
            execSync(conn.login.cmd, { stdio: "inherit" });
          } catch (e) {
            console.log(C.warn(`   ${conn.login.cmd} exited non-zero -- continue below if needed. (${e?.message || e})`));
          }
          if (conn.login.capture && conn.login.env) {
            // Token is printed by the login command and must be captured into the env.
            const tok = await ask(`   paste the token it printed (Enter to skip)`, seed[conn.login.env]);
            if (tok) v[conn.login.env] = tok;
          } else {
            // Host-only OAuth; container uses the API key. No token to capture.
            console.log(C.dim(`   (${conn.login.note})`));
          }
        } else if (conn.login?.capture && conn.login.env) {
          // CLI not installed but user may already hold a token.
          const tok = await ask(`   ${conn.login.env} ${C.dim("(Enter to skip)")}`, seed[conn.login.env]);
          if (tok) v[conn.login.env] = tok;
        } else if (!det.found && conn.install?.npm) {
          console.log(C.dim(`   Install later: npm i -g ${conn.install.npm}`));
        }
      } else {
        v[gateEnv] = "";
        if (cliId === "claude-code") {
          v.CLAUDE_CODE_OAUTH_TOKEN = v.CLAUDE_CODE_OAUTH_TOKEN ?? "";
        }
      }
    }

    // Phase 4: install profile + channels.
    phase(4, TOTAL_PHASES, "profile & channels");
    const picked = await chooseProfile(ask, guide);
    profile = picked.profile;
    composeProfiles = picked.composeProfiles;
    v.COMPOSE_PROFILES = composeProfiles;

    // Messaging channels -- any profile (they're the only interface in headless).
    await setupChannels(ask, v, seed, guide);

    // Workspaces config (only the Full profile bundles the IDE).
    if (composeProfiles.includes("workspace")) {
      console.log("");
      console.log(C.dim("  " + "-".repeat(56)));
      console.log(C.b("  Workspaces (code IDE)"));
      await guide?.narrate(
        "The Full profile includes Workspaces -- an in-browser code IDE. A GitHub token lets it " +
        "clone repos + open PRs; trusted folders are local paths it can edit directly. Both optional.",
      );
      v.GH_TOKEN = (await ask("GitHub token (repo scope -- clone/push/PR; Enter to skip)", seed.GH_TOKEN)) || "";
      v.WORKSPACE_TRUSTED_DIRS =
        (await ask("Trusted local folders (comma-sep absolute paths; Enter to skip)", seed.WORKSPACE_TRUSTED_DIRS)) || "";
    }

    // One-click updates: the `update` profile runs the updater sidecar so the Shell
    // can apply updates with a BUTTON (no terminal) — friendly for non-technical
    // users. It needs a UI, so add it for `ui` installs and keep it out of headless
    // (those update via `git pull && docker compose up -d --build` or the script).
    // ⚠ The sidecar mounts the host Docker socket (host-root-equivalent) — documented
    // in agent-install/README.md ("## Update"); it's internal-only + UPDATER_TOKEN-gated.
    {
      const parts = composeProfiles.split(",").map((p) => p.trim()).filter(Boolean);
      const base = parts.filter((p) => p !== "update");
      composeProfiles = (base.includes("ui") ? [...base, "update"] : base).join(",");
      v.COMPOSE_PROFILES = composeProfiles;
    }

    // Phase 5: configuration -- PIN + networking + secrets.
    phase(5, TOTAL_PHASES, "configuration");
    console.log(C.b("  Access PIN"));
    await guide?.narrate(
      "The user picks a PIN that unlocks the web UI. It's hashed with SHA-256 and the raw PIN " +
      "is never stored anywhere -- reassure them."
    );
    console.log(C.dim("   At least 6 digits; hashed with SHA-256 -- the raw PIN is never stored."));
    console.log(C.dim("   Note: the PIN will echo."));
    let pin = "";
    for (;;) {
      pin = await ask("  ? Choose a PIN");
      const err = pinError(pin);
      if (!err) break;
      console.log(C.err("   " + err));
    }
    v.PIN_HASH = pinHash(pin);
    v.CORE_TOKEN = seed.CORE_TOKEN || genHex();
    v.SESSION_SECRET = seed.SESSION_SECRET || genHex();
    v.LITELLM_MASTER_KEY = seed.LITELLM_MASTER_KEY || genHex();
    v.SPECTRE_SERVICE_TOKEN = seed.SPECTRE_SERVICE_TOKEN || genHex();
    v.WORKSPACE_SERVICE_TOKEN = seed.WORKSPACE_SERVICE_TOKEN || genHex();
    v.CODE_SERVER_PASSWORD = seed.CODE_SERVER_PASSWORD || genHex(16);
    v.GH_TOKEN = v.GH_TOKEN ?? seed.GH_TOKEN ?? "";
    v.WORKSPACE_TRUSTED_DIRS = v.WORKSPACE_TRUSTED_DIRS ?? seed.WORKSPACE_TRUSTED_DIRS ?? "";

    if (composeProfiles.includes("ui")) {
      console.log("");
      console.log(C.dim("  " + "-".repeat(56)));
      console.log(C.b("  Networking"));
      await guide?.narrate(
        "Networking. The default is loopback -- works on this machine straight away. Reaching it " +
        "from a phone over Tailscale needs HTTPS (tailscale serve), which the installer can set up; " +
        "mention they can keep the default for now."
      );
      v.SHELL_PORT = await ask("  ? Shell port", seed.SHELL_PORT || "3100");
      const expose = (await ask("  ? Expose beyond localhost? (only behind HTTPS) [y/N]", "N")).toLowerCase();
      if (expose === "y" || expose === "yes") {
        console.log(C.warn("   ! Non-localhost access must be behind HTTPS or tailscale serve."));
        console.log(C.warn("   ! Over plain HTTP on a non-localhost host the Secure session cookie"));
        console.log(C.warn("     drops, so login breaks."));
        console.log(C.warn("   ! This also exposes the PIN-gated host-shell surface beyond this machine."));
        const confirm = (await ask("  ? Confirm HTTPS/tailscale-serve is already in front? [y/N]", "N")).toLowerCase();
        v.SHELL_BIND = confirm === "y" || confirm === "yes" ? "0.0.0.0" : "127.0.0.1";
      } else {
        v.SHELL_BIND = "127.0.0.1";
      }
      await guidedTailscale(ask, v.SHELL_PORT, guide);
    } else {
      // Headless: no shell to expose. Loopback defaults (unused unless UI added later).
      v.SHELL_BIND = "127.0.0.1";
      v.SHELL_PORT = seed.SHELL_PORT || "3100";
      console.log(C.dim("\n  Headless -- no web UI. Interact via channels + the API.\n"));
    }

    await offerWslMemoryCap(ask);
  }
  rl.close();

  const body = renderEnv(buildEnv(v, seed));

  // Build the argv arrays for docker compose so we can pass them to collectComposeImages.
  // profileArgv: ["--profile", "ui"] or [] for headless.
  const profileArgParts = composeProfiles
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => ["--profile", p]);
  // Full argv for `docker compose` (without the subcommand).
  const mainComposeArgv = ["--env-file", ".env.docker", ...profileArgParts];
  // Reconstruct the string form for display / execSync.
  const composeCmdBase = ["docker", "compose", ...mainComposeArgv].join(" ");
  const composeCmd = `${composeCmdBase} up -d --build --quiet-pull`;

  if (dryRun) {
    console.log(C.dim(`\n  Profile: ${PROFILES[profile].label}  (COMPOSE_PROFILES="${composeProfiles}")`));
    console.log(C.b("\n  Would write .env.docker:\n"));
    console.log(body.split("\n").map((l) => C.dim("   " + l.replace(/=(.+)/, (m, val) => "=" + (val ? "***" : "")))).join("\n"));
    console.log(C.dim("\n  Would run: " + composeCmd));
    console.log(C.dim("  Would health-check: http://127.0.0.1:8787/api/health\n"));
    return;
  }

  writeFileSync(ENV_PATH, body, { mode: 0o600 });
  console.log(C.ok("\n  + wrote .env.docker") + C.dim(" (secrets, gitignored, mode 600)"));

  // Database schema note for cloud (local is handled in setupLocalDb later).
  if (!useLocalDb) {
    console.log("");
    console.log(C.dim("  " + "-".repeat(56)));
    console.log(C.b("  Database schema"));
    console.log(C.dim("   One time: open your Supabase project -> SQL Editor -> paste the contents of"));
    console.log("   " + C.accent("supabase/_apply_all.sql") + C.dim(" -> Run. (Safe to re-run.)"));
    console.log(C.dim("   The core's /api/health verifies it's applied -- the check below will catch it."));
  }

  // Persistent, user-extensible harness dir (skills/tools/mcp overlay the
  // baked built-ins + survive restarts). Mounted into the core at /data.
  const dataBase = setupDataDir();
  console.log(C.ok("\n  + data dir ready") + C.dim(` (${dataBase})`));
  console.log(C.dim("    Add skills/tools/mcp here; they persist across restarts."));

  // Port preflight (first install only -- re-runs legitimately reuse these ports).
  if (firstInstall) {
    const wantPorts = [
      { port: Number(v.SHELL_PORT) || 3100, who: "shell UI" },
      { port: 8787, who: "core" },
      { port: 4000, who: "litellm gateway" },
    ];
    if (useLocalDb) wantPorts.push({ port: 8000, who: "local-db gateway" }, { port: 5432, who: "local-db Postgres" });
    if (composeProfiles.includes("workspace"))
      wantPorts.push({ port: Number(v.CODE_SERVER_PORT) || 8088, who: "code-server" }, { port: Number(v.EDGE_PORT) || 8090, who: "edge proxy" });
    await checkPorts(wantPorts);
  }

  // Phase 6: downloads -- pull every pre-built image ONE AT A TIME before any `up`.
  // Sequence: local-db images first (if chosen), then main stack images. The core
  // is built from source (it has a `build:` key), so prePullImages skips it and
  // `docker compose up --build` compiles it locally in the launch phase.
  phase(6, TOTAL_PHASES, "downloads");
  console.log(C.dim("  Verifying images -- pulling anything not already cached...\n"));

  const localDbComposeArgv = useLocalDb
    ? ["-f", "local-db/docker-compose.yml", "--env-file", "local-db/.env"]
    : null;

  try {
    await prePullImages(mainComposeArgv, localDbComposeArgv);
  } catch (e) {
    // prePullImages already printed the classified error.
    process.exit(1);
  }

  // Phase 7: launch -- bring everything up sequentially; never two `up`s at once.
  phase(7, TOTAL_PHASES, "launch");

  // Step 7a: local-db up + wait for init + schema (only when local DB chosen).
  if (useLocalDb) {
    console.log(C.b("  Starting local database..."));
    try {
      // setupLocalDb() now skips the pull (done above); just does up + wait + schema.
      await setupLocalDb();
    } catch (e) {
      console.log(C.err("\n   " + (e?.message || e) + "\n"));
      process.exit(1);
    }
    console.log(C.ok("   + local database up + schema applied\n"));
  }

  // Step 7b: main stack up.
  console.log(C.b(`  Bringing up the stack -- ${PROFILES[profile].label} profile...`));
  console.log(C.dim("\n   " + composeCmd + "\n"));
  try {
    execSync(composeCmd, {
      cwd: ROOT,
      stdio: "inherit",
      // SPECTRE_BUILD_SHA bakes the built commit into the core image (compose
      // reads it via the core.build.args), so update detection works immediately.
      env: { ...process.env, COMPOSE_PROFILES: composeProfiles, SPECTRE_BUILD_SHA: gitSha() },
    });
  } catch {
    console.log(C.err("\n  docker compose failed -- check the output above.\n"));
    process.exit(1);
  }

  // Step 7c: health poll.
  const healthy = await healthCheck("http://127.0.0.1:8787/api/health");
  const port = v.SHELL_PORT || "3100";
  const host = tailnetHost();
  console.log(
    healthy
      ? C.ok("\n  + core healthy")
      : C.warn(
          "\n  ! core not ready -- `docker compose logs core`.\n" +
          "    If /api/health reports the schema isn't applied, run\n" +
          "    supabase/_apply_all.sql in the Supabase SQL editor (see above).",
        ),
  );
  await guide?.narrate(
    healthy
      ? "The stack is up and the core is healthy. In one or two upbeat sentences, tell the user they can open Spectre now, that the same link adapts to phone and desktop, and they unlock it with the PIN they set."
      : "The stack started but the core isn't answering yet. In one or two reassuring sentences, tell the user it may still be booting and to check `docker compose logs core` if it stays down.",
  );

  // ---- framed success panel --------------------------------------------------
  if (composeProfiles.includes("ui")) {
    const localUrl = `http://127.0.0.1:${port}`;
    const lines = [`  > ${localUrl}   (this machine)`];
    if (host) lines.push(`  > https://${host}   (tailnet)`);
    lines.push(`  Same URL adapts to desktop or mobile. PIN to enter.`);
    if (composeProfiles.includes("workspace")) {
      lines.push(`  Workspaces password (stored in .env.docker):`);
      lines.push(`    ${v.CODE_SERVER_PASSWORD}`);
    }
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const bar = "+" + "-".repeat(width) + "+";
    console.log("\n" + bar);
    console.log(C.b("|  Open Spectre" + " ".repeat(width - 14) + "|"));
    console.log("|" + " ".repeat(width) + "|");
    for (const ln of lines) console.log(C.accent("| ") + ln + " ".repeat(width - ln.length - 1) + C.accent("|"));
    console.log(bar);
  } else {
    const apiUrl = "http://127.0.0.1:8787/api/health";
    const chans = [
      v.TELEGRAM_BOT_TOKEN && "Telegram",
      v.WHATSAPP_TOKEN && "WhatsApp",
      v.DISCORD_BOT_TOKEN && "Discord",
    ].filter(Boolean);
    const chanLine = `  channels: ${chans.length ? chans.join(", ") : "none (add tokens in .env.docker)"}`;
    const lines = [`  > ${apiUrl}   (core API, loopback)`, chanLine, '  Add UI later: COMPOSE_PROFILES="ui" in .env.docker'];
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const bar = "+" + "-".repeat(width) + "+";
    console.log("\n" + bar);
    console.log(C.b("|  Spectre is running (headless)" + " ".repeat(width - 31) + "|"));
    console.log("|" + " ".repeat(width) + "|");
    for (const ln of lines) console.log(C.accent("| ") + ln + " ".repeat(width - ln.length - 1) + C.accent("|"));
    console.log(bar);
  }
  console.log(C.dim("\n  Re-run / update anytime:  " + composeCmd + "\n"));

  // Boot service (so it survives restarts) + help finishing channels / Tailscale.
  await finishingTouches({ guide, v, composeProfiles, port });
}

async function healthCheck(url, tries = 30, gapMs = 2000) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = AbortSignal.timeout(3000);
      const r = await fetch(url, { signal: ctl });
      if (r.ok) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return false;
}

// Post-install helpers: an optional systemd boot service + setup assistance.
const isLinux = () => process.platform === "linux";
const hasSystemd = () => isLinux() && tryCmd("systemctl --version") !== null;
function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Install + enable a systemd unit so the stack comes back on every boot (Docker's
 * own restart policy doesn't re-`up` a stack that was `down` at shutdown). Linux
 * only; writes to /etc/systemd/system via sudo. composeProfiles drives --profile.
 */
function installSystemdService(composeProfiles) {
  const dockerPath = tryCmd("command -v docker") || "/usr/bin/docker";
  const profileFlags = composeProfiles
    .split(",").map((s) => s.trim()).filter(Boolean).map((p) => `--profile ${p}`).join(" ");
  const start = [dockerPath, "compose", "--env-file", ".env.docker", profileFlags, "up", "-d"]
    .filter(Boolean).join(" ");
  const unit = [
    "[Unit]",
    "Description=Spectre self-hosted AI assistant",
    "Requires=docker.service",
    "After=docker.service network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `WorkingDirectory=${ROOT}`,
    `ExecStart=${start}`,
    `ExecStop=${dockerPath} compose --env-file .env.docker stop`,
    "TimeoutStartSec=0",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");

  const tmp = join(tmpdir(), "spectre.service");
  try {
    writeFileSync(tmp, unit);
    console.log(C.dim("\n   Installing the boot service (needs sudo)..."));
    execSync(`sudo install -m 644 "${tmp}" /etc/systemd/system/spectre.service`, { stdio: "inherit" });
    execSync("sudo systemctl daemon-reload", { stdio: "inherit" });
    execSync("sudo systemctl enable spectre.service", { stdio: "inherit" });
    console.log(C.ok("   + spectre.service installed + enabled -- Spectre now starts on boot"));
    console.log(C.dim("     Manage it with: systemctl start|stop|status spectre"));
    if (isWsl()) {
      console.log(C.warn("     WSL note: this only helps once WSL itself is running -- also enable WSL"));
      console.log(C.warn("     autostart on Windows boot, or the VM (and this service) never starts."));
    }
  } catch (e) {
    console.log(C.err("   x boot service setup failed -- ") + C.dim(String(e?.message || e).split("\n")[0]));
  } finally {
    try { unlinkSync(tmp); } catch { /* tmp already gone */ }
  }
}

/** The AI guide's brief for walking the user through a still-unconfigured topic. */
function helpStepPrompt(topic, port) {
  if (topic === "channels") {
    return (
      "Walk the user through adding a messaging channel to Spectre (Telegram is the easiest). " +
      "Keep it to a few concise, friendly steps: create a bot via @BotFather and copy its token into " +
      "TELEGRAM_BOT_TOKEN in .env.docker; set TELEGRAM_ALLOWED_SENDER_IDS to their own Telegram user id; " +
      "point the Telegram webhook at https://<their-host>/api/channels/telegram/webhook; then " +
      "`docker compose up -d`. Mention the full per-channel steps live in .env.docker.example."
    );
  }
  return (
    "Walk the user through exposing Spectre securely over Tailscale so they can reach it from their phone. " +
    "Concise, friendly steps: install Tailscale and run `tailscale up`; then " +
    `\`tailscale serve --bg https / http://127.0.0.1:${port}\`; open the resulting ` +
    "https://<machine>.<tailnet>.ts.net URL and unlock with their PIN. Note that HTTPS is required so the " +
    "secure session cookie sets, and that full notes live in docs/M6-INSTALLER.md."
  );
}

/**
 * Post-install: offer a boot service, then help finish whatever was skipped
 * (channels / Tailscale) -- via the installed AI guide if one is active, else by
 * pointing at the in-repo docs. Manages its own readline (the wizard's is closed).
 */
async function finishingTouches({ guide, v, composeProfiles, port }) {
  const tailnet = tailnetHost();
  const hasChannels = !!(v.TELEGRAM_BOT_TOKEN || v.WHATSAPP_TOKEN || v.DISCORD_BOT_TOKEN);
  const pending = [];
  if (!hasChannels) pending.push("channels");
  if (composeProfiles.includes("ui") && !tailnet) pending.push("tailscale");

  console.log("");
  console.log(C.dim("  " + "-".repeat(56)));
  console.log(C.b("  Finishing touches"));

  // Gather decisions up front, then close the readline before any sudo/inherit.
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q, def = "") => (await rl.question(`   ${q}${def ? C.dim(` [${def}]`) : ""}: `)).trim() || def;

  let wantSystemd = false;
  if (hasSystemd()) {
    wantSystemd = /^y/i.test(await ask("  ? Start Spectre automatically on boot (systemd service)? [Y/n]", "Y"));
  } else if (isLinux()) {
    console.log(C.dim("   (systemd not detected -- skipping the boot service.)"));
  } else {
    console.log(C.dim(`   (boot service is Linux/systemd only; on this OS, ${process.platform === "win32" ? "Docker Desktop's 'start on login' keeps it up" : "use your init system / Docker Desktop autostart"}.)`));
  }

  let wantHelp = false;
  if (guide && pending.length) {
    wantHelp = /^y/i.test(await ask(`  ? Have the assistant help you set up ${pending.join(" + ")}? [y/N]`, "N"));
  }
  rl.close();

  if (wantSystemd) installSystemdService(composeProfiles);

  // The in-repo guides -- always shown as the reliable reference.
  if (pending.length) {
    console.log(C.dim("\n   Finish setup anytime -- guides in the repo:"));
    if (pending.includes("channels"))
      console.log("   " + C.accent(".env.docker.example") + C.dim("   -- Telegram / WhatsApp / Discord (step-by-step)"));
    if (pending.includes("tailscale"))
      console.log("   " + C.accent("docs/M6-INSTALLER.md") + C.dim("  -- Tailscale HTTPS (remote access)"));
  }

  if (wantHelp) {
    for (const topic of pending) await guide.narrate(helpStepPrompt(topic, port));
  } else if (pending.length) {
    console.log(C.dim("   Add them by editing .env.docker, then re-run this installer -> Update."));
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((e) => {
    console.error(C.err("\n  installer error: " + (e?.message || e)));
    process.exit(1);
  });
}
