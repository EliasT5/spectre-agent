#!/usr/bin/env node
// MOCK installer — walks the EXACT red-thread of the real installer
// (installer/install.mjs) with the conversational narrator, but performs ZERO
// real actions: no Docker, no file writes, no network, no secrets. It's a safe
// dry-run you can click through to feel the flow (and to demo the narrator).
//
//   node installer/mock-install.mjs
//
// The red thread (same as the real wizard):
//   1 PREFLIGHT  detect Docker / Ollama / CLIs
//   2 GUIDE      pick a narrator — an installed CLI or an Ollama model (or pull one)
//   3 DATA       local self-hosted DB (default) OR your own cloud Supabase
//   4 BRAIN      pick the ONE model Spectre thinks with (remembered; add more in Settings)
//   5 ACCESS     choose a PIN
//   6 NETWORK    loopback (default) or exposed behind HTTPS
//   7 LAUNCH     write .env.docker + `docker compose up`   (MOCK: skipped)
//   8 VERIFY     health-check the core                      (MOCK: faked green)
//   9 OPEN       print the links
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";
import { chooseNarrator, detectNarrators } from "./narrator.mjs";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  accent: (s) => `\x1b[38;5;99m${s}\x1b[0m`,
};
const MOCK = C.warn("[MOCK]");
const has = (bin) => {
  try { return spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 6000 }).status === 0; } catch { return false; }
};

// A canned narrator for --auto: shows WHERE narration appears, no live model.
function mockNarrator() {
  const p = (t) => console.log(`   ${C.accent("◈")}  ${C.dim("(guide) " + t)}`);
  return {
    narrate: async (s) => p(s.length > 90 ? s.slice(0, 90) + "…" : s),
    detected: async () => p("Looks good — let's get you set up."),
    answer: async (q) => p("re: " + q),
  };
}

async function main() {
  const AUTO = process.argv.includes("--auto");
  console.log(C.accent(C.b("\n  S P E C T R E  ·  installer  ")) + C.warn(`(MOCK${AUTO ? " · auto" : ""} — nothing will be installed)`));
  console.log(C.dim("  A safe walk-through of the real install flow. No Docker, no files, no network.\n"));

  const rl = AUTO ? null : createInterface({ input: stdin, output: stdout });
  const ask = async (q, def = "") => {
    if (AUTO) {
      console.log(`   ${q}${def ? C.dim(` [${def}]`) : ""}: ${C.dim(`(auto → ${def || "skip"})`)}`);
      return def;
    }
    const a = (await rl.question(`   ${q}${def ? C.dim(` [${def}]`) : ""}: `)).trim();
    return a || def;
  };

  // ── 1 · PREFLIGHT ────────────────────────────────────────────────────────
  step("1 · PREFLIGHT", "Detect what's already on this machine.");
  const docker = has("docker");
  const ollama = has("ollama");
  const clis = ["claude", "gemini", "codex"].filter(has);
  line("docker", docker);
  line("ollama", ollama);
  line("CLIs", clis.length > 0, clis.join(", ") || "none");
  console.log(C.dim(`   ${MOCK} real installer would require Docker + Compose here (exit if missing).`));

  // ── 2 · GUIDE (the narrator) ─────────────────────────────────────────────
  step("2 · GUIDE", "Pick a local model OR an installed CLI to narrate the rest.");
  const narr = AUTO ? mockNarrator() : await chooseNarrator(rl, ask);
  await narr?.detected(
    `docker: ${docker ? "found" : "MISSING"}\nollama: ${ollama ? "running" : "not running"}\nCLIs: ${clis.join(", ") || "none"}`,
  );

  // ── 3 · DATA ─────────────────────────────────────────────────────────────
  step("3 · DATA", "Where Spectre stores chat, memory and config.");
  await narr?.narrate("Choosing the database: Local is a self-hosted Supabase bundled here (zero cloud account, default); Cloud is the user's own supabase.com project.");
  const db = (await ask("Database: [L]ocal self-hosted or [C]loud Supabase?", "L")).toLowerCase();
  const useLocal = !(db === "c" || db === "cloud");
  console.log(C.dim(`   ${MOCK} would ${useLocal ? "generate keys + start the bundled local Supabase + apply the schema" : "save your Supabase URL/keys (schema = one SQL-editor paste)"}.`));

  // ── 4 · BRAIN (remember the one model) ───────────────────────────────────
  step("4 · BRAIN", "The ONE model Spectre thinks with. Add more later in Settings → Providers.");
  await narr?.narrate("Choosing the brain model: local Ollama needs no keys; or bring an API key for a hosted model. Only ONE is configured now; more are added in Settings.");
  const brainOpts = await detectNarrators(); // same detection surfaces the candidates
  if (brainOpts.length) brainOpts.forEach((o, i) => console.log(`   ${C.dim(`${i + 1})`)} ${o.label}`));
  console.log(`   ${C.dim(`${brainOpts.length + 1})`)} an API model (paste a key) ${C.dim("· e.g. anthropic/claude-sonnet-4-6")}`);
  const bpick = (await ask(`Brain model [1-${brainOpts.length + 1}]`, "1")).trim();
  const idx = Number(bpick) - 1;
  const brain =
    brainOpts[idx]?.id ||
    (bpick === String(brainOpts.length + 1) ? (await ask("Provider model id", "anthropic/claude-sonnet-4-6")) : (brainOpts[0]?.id ?? "spectre-default"));
  console.log(C.ok(`   ✓ remembered brain model: ${C.b(brain)}`) + C.dim("  (written to the gateway config + .env; change/add in Settings)"));
  await narr?.narrate(`The user picked ${brain} as Spectre's brain. Reassure them it's saved and that they can add or switch models anytime in Settings.`);

  // ── 5 · ACCESS ───────────────────────────────────────────────────────────
  step("5 · ACCESS", "A PIN unlocks the web UI (hashed; the raw PIN is never stored).");
  const pin = await ask("Choose a PIN (≥6 digits)", "739281");
  console.log(C.dim(`   ${MOCK} would store SHA-256(PIN) as PIN_HASH — the raw PIN '${pin}' is never written.`));

  // ── 6 · NETWORK ──────────────────────────────────────────────────────────
  step("6 · NETWORK", "Loopback by default; expose only behind HTTPS.");
  const expose = (await ask("Expose beyond localhost? (only behind HTTPS) [y/N]", "N")).toLowerCase();
  console.log(C.dim(`   ${MOCK} bind = ${expose === "y" || expose === "yes" ? "0.0.0.0 (you confirmed HTTPS)" : "127.0.0.1 (loopback)"} on port 3100.`));

  // ── 7 · LAUNCH ───────────────────────────────────────────────────────────
  step("7 · LAUNCH", "Write .env.docker (mode 600) + bring the stack up.");
  await narr?.narrate("About to write the secrets file and start the containers. In the real run this builds the shell and the core from source.");
  console.log(C.dim(`   ${MOCK} would write .env.docker (mode 600) and run:`));
  if (useLocal) {
    // Local DB is a SEPARATE compose project (a trimmed self-hosted Supabase:
    // postgres+pgvector, PostgREST, Realtime, Kong), brought up first and seeded
    // with supabase/_apply_all.sql, THEN the main stack points at it.
    console.log(C.dim(`   ${MOCK}   docker compose -f local-db/docker-compose.yml --env-file local-db/.env up -d`));
    console.log(C.dim(`   ${MOCK}   # …poll roles, create supabase_realtime publication, apply supabase/_apply_all.sql`));
    console.log(C.dim(`   ${MOCK}   docker compose up -d --build   # SUPABASE_URL=http://host.docker.internal:8000`));
  } else {
    console.log(C.dim(`   ${MOCK}   docker compose up -d --build`));
  }

  // ── 8 · VERIFY ───────────────────────────────────────────────────────────
  step("8 · VERIFY", "Health-check the core until it answers.");
  console.log(C.ok("   ✓ core healthy") + C.dim(`  ${MOCK} faked — real run polls http://127.0.0.1:8787/api/health`));

  // ── 9 · OPEN ─────────────────────────────────────────────────────────────
  step("9 · OPEN", "You're in.");
  console.log("   " + C.accent("http://127.0.0.1:3100") + C.dim("   (this machine — enter your PIN)"));
  await narr?.narrate("Wrap up warmly in one line: the mock walk-through is done; in a real run Spectre would now be open at that link.");

  console.log(C.b("\n  ── red thread ──"));
  console.log(C.dim("  preflight → guide → data → brain → access → network → launch → verify → open"));
  console.log(C.warn("\n  This was a MOCK. Nothing was installed, written, or pulled. Run installer/install.mjs for real.\n"));
  rl?.close();
}

function step(title, sub) {
  console.log(`\n${C.accent("  ◆")} ${C.b(title)}  ${C.dim(sub)}`);
}
function line(label, ok, extra = "") {
  console.log(`   ${ok ? C.ok("●") : C.dim("○")} ${label.padEnd(8)} ${C.dim(ok ? extra || "found" : extra || "not found")}`);
}

main().catch((e) => {
  console.error(C.warn("\n  mock installer error: " + (e?.message || e)));
  process.exit(1);
});
