#!/usr/bin/env node

import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";
import {
  existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, copyFileSync,
} from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ENV_PATH = join(ROOT, ".env.docker");
const STAGE = join(HERE, "imported");
const HOME = homedir();
const CFG = process.env.XDG_CONFIG_HOME || join(HOME, ".config");

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  accent: (s) => `\x1b[38;5;99m${s}\x1b[0m`,
};

// foreign key → Spectre's .env.docker key
const KEY_ALIAS = {
  GEMINI_API_KEY: "GOOGLE_GENAI_API_KEY", GOOGLE_API_KEY: "GOOGLE_GENAI_API_KEY",
};
// Spectre's actual .env.docker slots — only these merge into .env.docker.
// (No anon key: the shell holds no storage credentials.)
const SPECTRE_ENV = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENAI_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
]);
// recognized provider/tool keys worth carrying (others go to <source>/carried.env).
const CARRY_KEYS = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "OPENROUTER_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY", "FIRECRAWL_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "BRAVE_API_KEY",
  "SEARXNG_URL", "GITHUB_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
]);
const CHANNEL_KEY = /^(TELEGRAM|DISCORD|SLACK|SIGNAL|WHATSAPP|MATRIX|IMESSAGE)_/;

export const SOURCES = [
  {
    id: "hermes", name: "Hermes (Nous Research)",
    roots: [process.env.HERMES_HOME, join(HOME, ".hermes")],
    guard: ["config.yaml", "state.db", "SOUL.md"],
    env: [".env"],
    config: [{ rel: "config.yaml", kind: "yaml" }, { rel: "auth.json", kind: "json" }],
    persona: ["SOUL.md", "AGENTS.md"],
    memory: ["memories/MEMORY.md", "memories/USER.md"],
    db: ["state.db"],
  },
  {
    id: "openclaw", name: "OpenClaw",
    roots: [process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_HOME, join(HOME, ".openclaw"), join(HOME, ".clawdbot"), join(HOME, ".moltbot")],
    guard: ["openclaw.json", ".env"],
    env: [".env", join(CFG, "openclaw", "gateway.env")],
    config: [{ rel: "openclaw.json", kind: "json5" }, { rel: "secrets.json", kind: "json" }],
    persona: ["workspace/SOUL.md", "workspace/AGENTS.md", "workspace/IDENTITY.md"],
    memory: ["workspace/MEMORY.md", "workspace/USER.md", "workspace/memory"],
    db: ["memory"],
  },
];

const resolveUnder = (root, p) => (isAbsolute(p) ? p : join(root, p));

function parseEnvLike(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1].toUpperCase()] = m[2].replace(/^["']|["',]$/g, "");
  }
  return out;
}

// Best-effort JSON5 → JSON: drop comments + trailing commas, then parse.
function parseLoose(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  try {
    const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const noLine = noBlock.replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
    const noTrail = noLine.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrail);
  } catch { return null; }
}

function crawl(node, keys, models, depth = 0) {
  if (!node || depth > 7) return;
  if (Array.isArray(node)) return node.forEach((n) => crawl(n, keys, models, depth + 1));
  if (typeof node !== "object") return;
  for (const [k, val] of Object.entries(node)) {
    const K = k.toUpperCase();
    if (typeof val === "string") {
      if (/(API_?KEY|TOKEN|SECRET)$/.test(K) || CARRY_KEYS.has(K)) keys[K] = keys[K] || val;
      if (/(MODEL|PRIMARY|DEFAULT)/.test(K) && /[a-z].*[-/]/i.test(val) && !/embed/i.test(val)) models.add(val);
    } else crawl(val, keys, models, depth + 1);
  }
}

function readText(p, cap = 400_000) {
  try { const t = readFileSync(p, "utf8"); return t.length > cap ? null : t; } catch { return null; }
}

// Pull config files into { keys, models } (env + json + json5 + light yaml).
function readConfig(root, spec) {
  const keys = {}, models = new Set();
  for (const rel of spec.env || []) {
    const t = readText(resolveUnder(root, rel));
    if (t) Object.assign(keys, { ...parseEnvLike(t), ...keys });
  }
  for (const { rel, kind } of spec.config || []) {
    const p = resolveUnder(root, rel);
    const t = readText(p);
    if (!t) continue;
    if (kind === "yaml") {
      // light: any "provider/model"-looking value + any KEY: value secrets
      for (const m of t.matchAll(/([a-z][\w.-]*\/[\w.:-]+)/gi)) {
        if (!/embed/i.test(m[1])) models.add(m[1]);
      }
      Object.assign(keys, { ...parseEnvLike(t), ...keys });
    } else {
      const j = parseLoose(t);
      if (j) crawl(j, keys, models);
    }
  }
  // normalize via alias
  const norm = {};
  for (const [k, v] of Object.entries(keys)) {
    if (!v) continue;
    norm[KEY_ALIAS[k] || k] = norm[KEY_ALIAS[k] || k] || v;
  }
  return { keys: norm, models: [...models] };
}

function listMd(root, rels) {
  const out = [];
  for (const rel of rels) {
    const p = resolveUnder(root, rel);
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const f of readdirSync(p)) if (f.endsWith(".md")) out.push(join(p, f));
      } else out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

function listDb(root, rels) {
  const out = [];
  for (const rel of rels) {
    const p = resolveUnder(root, rel);
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const f of readdirSync(p)) if (/\.(db|sqlite3?)$/.test(f)) out.push(join(p, f));
      } else if (/\.(db|sqlite3?)$/.test(p)) out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

export function detect(source) {
  const root = (source.roots || []).filter(Boolean).find((r) => existsSync(r) && source.guard.some((g) => existsSync(join(r, g))));
  if (!root) return null;
  const { keys, models } = readConfig(root, source);
  return {
    ...source, root, keys, models,
    persona: listMd(root, source.persona || []),
    memory: listMd(root, source.memory || []),
    dbs: listDb(root, source.db || []),
  };
}

function mergeEnv(keys) {
  const existing = existsSync(ENV_PATH) ? parseEnvLike(readFileSync(ENV_PATH, "utf8")) : {};
  const added = [], carried = {};
  for (const [k, val] of Object.entries(keys)) {
    if (SPECTRE_ENV.has(k)) { if (!existing[k]) { existing[k] = val; added.push(k); } }
    else if (CARRY_KEYS.has(k) || CHANNEL_KEY.test(k)) carried[k] = val;
  }
  if (added.length) {
    const body = Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    writeFileSync(ENV_PATH, body, { mode: 0o600 });
  }
  return { added, carried };
}

function stageFiles(srcId, label, files) {
  if (!files.length) return [];
  const dir = join(STAGE, srcId);
  mkdirSync(dir, { recursive: true });
  const staged = [];
  for (const f of files) {
    const dest = join(dir, `${label}-${basename(f)}`);
    try { copyFileSync(f, dest); staged.push(dest); } catch { /* skip */ }
  }
  return staged;
}

function stageCarried(srcId, carried) {
  const entries = Object.entries(carried);
  if (!entries.length) return null;
  const dir = join(STAGE, srcId);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "carried.env");
  writeFileSync(out, `# Carried from ${srcId} — keys/tokens Spectre has no slot for yet\n` + entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(C.accent(C.b("\n  Spectre · import from the competition")));
  console.log(C.dim("  detect Hermes / OpenClaw and carry the config over\n"));

  const found = SOURCES.map(detect).filter(Boolean);
  if (!found.length) {
    console.log(C.dim("  No Hermes (~/.hermes) or OpenClaw (~/.openclaw, ~/.clawdbot, ~/.moltbot) install found.\n"));
    return;
  }

  const rl = dryRun ? null : createInterface({ input: stdin, output: stdout });
  for (const s of found) {
    const spectreKeys = Object.keys(s.keys).filter((k) => SPECTRE_ENV.has(k));
    const channels = Object.keys(s.keys).filter((k) => CHANNEL_KEY.test(k));
    console.log(C.b(`  Found ${s.name}`) + C.dim(` — ${s.root}`));
    console.log(`    ${spectreKeys.length ? C.ok("●") : C.dim("○")} provider keys → .env.docker: ${C.dim(spectreKeys.join(", ") || "none")}`);
    console.log(`    ${channels.length ? C.ok("●") : C.dim("○")} channel tokens: ${C.dim(channels.join(", ") || "none")}`);
    console.log(`    ${s.models.length ? C.ok("●") : C.dim("○")} models: ${C.dim(s.models.slice(0, 6).join(", ") || "none")}`);
    console.log(`    ${s.persona.length ? C.ok("●") : C.dim("○")} persona/identity: ${C.dim(s.persona.map((f) => basename(f)).join(", ") || "none")}`);
    console.log(`    ${s.memory.length ? C.ok("●") : C.dim("○")} memory: ${C.dim(s.memory.map((f) => basename(f)).join(", ") || "none")}`);
    console.log(`    ${s.dbs.length ? C.ok("●") : C.dim("○")} history DB: ${C.dim(s.dbs.map((f) => basename(f)).join(", ") || "none")}${s.dbs.length ? C.dim("  (re-index later, not copied)") : ""}`);

    if (dryRun) { console.log(C.dim("    → would merge provider keys + stage persona/memory/carried\n")); continue; }

    const yes = (await rl.question(`    Import ${s.name} into Spectre? ${C.dim("[y/N]")}: `)).trim().toLowerCase();
    if (yes !== "y" && yes !== "yes") { console.log(C.dim("    skipped\n")); continue; }

    const { added, carried } = mergeEnv(s.keys);
    const sp = stageFiles(s.id, "soul", s.persona);
    const sm = stageFiles(s.id, "memory", s.memory);
    const cf = stageCarried(s.id, carried);

    console.log(C.ok(`    ✓ merged ${added.length} provider key(s) into .env.docker`) + (added.length ? C.dim(` (${added.join(", ")})`) : ""));
    if (sp.length) console.log(C.ok(`    ✓ staged ${sp.length} persona/identity file(s)`) + C.dim(` → installer/imported/${s.id}/  (copy into spectre-core/soul/)`));
    if (sm.length) console.log(C.ok(`    ✓ staged ${sm.length} memory file(s)`) + C.dim("  (re-add via the Memory tab so Spectre re-embeds them)"));
    if (cf) console.log(C.ok(`    ✓ carried ${Object.keys(carried).length} extra key(s)/token(s)`) + C.dim(` → ${cf}`));
    if (s.dbs.length) console.log(C.dim(`    • history DB at ${s.dbs[0]} — re-index later (embeddings differ; raw copy won't work)`));
    console.log();
  }
  rl?.close();
  console.log(C.dim("  Done. Re-run `node installer/install.mjs` — imported provider keys pre-fill the prompts.\n"));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((e) => { console.error("import error:", e?.message || e); process.exit(1); });
}
