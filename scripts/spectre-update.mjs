#!/usr/bin/env node
/**
 * Spectre self-update CLI — runs on the HOST (not in a container), so it works
 * even when the shell/core containers are down or broken. Node built-ins only.
 *
 *   node scripts/spectre-update.mjs --check            # am I behind origin/main?
 *   node scripts/spectre-update.mjs --apply            # pull + rebuild + recreate + health-check
 *   node scripts/spectre-update.mjs --apply --target core   # core + its runners only
 *   node scripts/spectre-update.mjs --apply --target shell  # shell only
 *
 * Flags:
 *   --check          (default) fetch origin/main and report behind/up-to-date.
 *                    Exit 0 = up to date, 10 = updates available.
 *   --apply | --yes  pull --ff-only, rebuild the target images (baking the new
 *                    git SHA in as SPECTRE_BUILD_SHA), recreate the containers,
 *                    then poll the core health endpoint.
 *   --target both|core|shell   what to rebuild (default: both).
 *   --force          apply even with a dirty working tree / no new commits.
 *
 * The stack is addressed exactly the way it was launched:
 *   docker compose -p spectre --env-file .env.docker -f docker-compose.yml ...
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "origin";
const BRANCH = "main";
const COMPOSE = ["compose", "-p", "spectre", "--env-file", ".env.docker", "-f", "docker-compose.yml"];
const CORE_HEALTH_URL = "http://127.0.0.1:8787/api/health";
// A core update must recreate every service that runs the spectre-core:local image.
const CORE_SERVICES = ["core", "chat-runner", "scheduler", "channel-runner"];

// ── tiny helpers ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(msg);
}

function fail(msg, code = 1) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

/** Run a command, streaming output to the terminal. Throws on non-zero exit. */
function run(cmd, args, opts = {}) {
  log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited with code ${r.status}`);
}

/** Run a command and capture stdout (trimmed). Throws on non-zero exit. */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${r.status}: ${(r.stderr || "").trim()}`);
  }
  return (r.stdout || "").trim();
}

const git = (...args) => capture("git", args);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── flag parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = { check: false, apply: false, force: false, target: "both" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") flags.check = true;
    else if (a === "--apply" || a === "--yes") flags.apply = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--target") flags.target = argv[++i] ?? "";
    else if (a.startsWith("--target=")) flags.target = a.slice("--target=".length);
    else if (a === "--help" || a === "-h") {
      log("Usage: node scripts/spectre-update.mjs [--check] [--apply|--yes] [--target both|core|shell] [--force]");
      process.exit(0);
    } else fail(`Unknown flag: ${a} (try --help)`, 2);
  }
  if (!["both", "core", "shell"].includes(flags.target)) {
    fail(`--target must be both, core or shell (got "${flags.target}")`, 2);
  }
  if (!flags.apply) flags.check = true; // --check is the default mode
  return flags;
}

// ── check ───────────────────────────────────────────────────────────────────

/** Fetch + compare HEAD vs origin/main. Returns { behind, local, remote }. */
function checkStatus() {
  log(`Fetching ${REMOTE}/${BRANCH}…`);
  git("fetch", REMOTE, BRANCH);
  const local = git("rev-parse", "HEAD");
  const remote = git("rev-parse", `${REMOTE}/${BRANCH}`);
  if (local === remote) return { behind: 0, local, remote };
  const behind = Number(git("rev-list", "--count", `HEAD..${REMOTE}/${BRANCH}`));
  return { behind, local, remote };
}

function doCheck() {
  const { behind, local, remote } = checkStatus();
  if (behind === 0) {
    log(`✓ Spectre is up to date (${local.slice(0, 12)}).`);
    process.exit(0);
  }
  log(`Spectre is ${behind} commit${behind === 1 ? "" : "s"} behind ${REMOTE}/${BRANCH}:`);
  log(`  local:  ${local.slice(0, 12)}`);
  log(`  remote: ${remote.slice(0, 12)}\n`);
  log(git("log", "--oneline", `HEAD..${REMOTE}/${BRANCH}`));
  log(`\nRun: node scripts/spectre-update.mjs --apply   (add --target core|shell to narrow)`);
  process.exit(10);
}

// ── apply ───────────────────────────────────────────────────────────────────

function buildAndUp(sha, target) {
  // SPECTRE_BUILD_SHA flows in twice on purpose: as a compose variable (the
  // compose file's `args:` entry reads it) AND as an explicit --build-arg, so
  // the built image knows exactly which commit it was built from.
  const env = { ...process.env, SPECTRE_BUILD_SHA: sha };
  const compose = (args) => run("docker", [...COMPOSE, ...args], { env });

  if (target === "core" || target === "both") {
    log(`\n── Rebuilding core (SPECTRE_BUILD_SHA=${sha.slice(0, 12)}) ──`);
    compose(["build", "--build-arg", `SPECTRE_BUILD_SHA=${sha}`, "core"]);
    log(`\n── Recreating core + runners (${CORE_SERVICES.join(", ")}) ──`);
    compose(["up", "-d", ...CORE_SERVICES]);
  }
  if (target === "shell" || target === "both") {
    log(`\n── Rebuilding shell (SPECTRE_BUILD_SHA=${sha.slice(0, 12)}) ──`);
    compose(["build", "--build-arg", `SPECTRE_BUILD_SHA=${sha}`, "shell"]);
    log(`\n── Recreating shell ──`);
    compose(["up", "-d", "shell"]);
  }
}

async function healthCheck() {
  log(`\nHealth-checking the core at ${CORE_HEALTH_URL}…`);
  const attempts = 12;
  let lastError = "no response";
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(CORE_HEALTH_URL, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        log(`✓ Core is healthy (attempt ${i}/${attempts}).`);
        return true;
      }
      lastError = `HTTP ${r.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (i < attempts) await sleep(5000);
  }
  log(`✗ Core did not become healthy after ${attempts} attempts (last: ${lastError}).`);
  return false;
}

function printRollback(prevSha, target) {
  log(`\n── Rollback steps (previous commit: ${prevSha}) ──`);
  log(`  cd "${REPO_ROOT}"`);
  log(`  git reset --hard ${prevSha}`);
  const compose = `docker compose -p spectre --env-file .env.docker -f docker-compose.yml`;
  if (target === "core" || target === "both") {
    log(`  ${compose} build --build-arg SPECTRE_BUILD_SHA=${prevSha} core`);
    log(`  ${compose} up -d ${CORE_SERVICES.join(" ")}`);
  }
  if (target === "shell" || target === "both") {
    log(`  ${compose} build --build-arg SPECTRE_BUILD_SHA=${prevSha} shell`);
    log(`  ${compose} up -d shell`);
  }
}

async function doApply(flags) {
  // Guard: never pull over uncommitted work.
  const dirty = git("status", "--porcelain");
  if (dirty && !flags.force) {
    fail(
      `Working tree is not clean — commit/stash your changes first (or pass --force):\n${dirty}`,
    );
  }
  if (dirty && flags.force) log("⚠ Working tree is dirty — continuing because of --force.");

  const prevSha = git("rev-parse", "HEAD");
  const { behind } = checkStatus();
  if (behind === 0 && !flags.force) {
    log(`✓ Already up to date (${prevSha.slice(0, 12)}) — nothing to apply.`);
    log(`  (Pass --force to rebuild anyway.)`);
    process.exit(0);
  }

  log(`\n── Pulling ${REMOTE}/${BRANCH} (fast-forward only) ──`);
  try {
    run("git", ["pull", "--ff-only", REMOTE, BRANCH]);
  } catch (err) {
    fail(`git pull --ff-only failed (diverged history?): ${err.message}`);
  }
  const newSha = git("rev-parse", "HEAD");
  log(`\nUpdated ${prevSha.slice(0, 12)} → ${newSha.slice(0, 12)} (target: ${flags.target}).`);

  try {
    buildAndUp(newSha, flags.target);
  } catch (err) {
    log(`\n✗ Build/recreate failed: ${err.message}`);
    printRollback(prevSha, flags.target);
    process.exit(1);
  }

  const healthy = await healthCheck();
  if (!healthy) {
    printRollback(prevSha, flags.target);
    process.exit(1);
  }

  log(`\n✓ Spectre updated to ${newSha.slice(0, 12)} and the core is healthy. Enjoy.`);
  process.exit(0);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(path.join(REPO_ROOT, "docker-compose.yml"))) {
    fail(`Not a Spectre repo: docker-compose.yml not found in ${REPO_ROOT}`);
  }
  if (!existsSync(path.join(REPO_ROOT, ".env.docker"))) {
    fail(`.env.docker not found in ${REPO_ROOT} — is this the installed stack?`);
  }

  const flags = parseArgs(process.argv.slice(2));
  try {
    if (flags.apply) await doApply(flags);
    else doCheck();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

await main();
