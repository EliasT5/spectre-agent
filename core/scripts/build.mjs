#!/usr/bin/env bun
/**
 * Compile all Spectre core binaries with `bun build --compile` — the standalone
 * artifacts that REPLACE the Next.js build. One binary per process:
 *   spectre-core            the HTTP API server
 *   spectre-broker          the MCP tool broker
 *   spectre-chat-runner     durable-chat executor
 *   spectre-scheduler       scheduled-jobs runner
 *   spectre-channel-runner  messaging-channel runner
 *
 * The subscription CLIs (Claude / Codex / Gemini) are neither baked in nor out:
 * they run on the operator's own machine and subscription, gated purely at
 * runtime by `SPECTRE_ALLOW_*_CLI` (see src/lib/ai/cli-gate.ts). One core build.
 *
 * Default target = bun-linux-x64 (docker/deploy; cross-compiles from any host).
 *   bun scripts/build.mjs                       # public linux binaries -> dist/
 *   bun scripts/build.mjs --host                # this machine (.exe on Windows)
 *   bun scripts/build.mjs --target=bun-darwin-arm64
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });

const host = process.argv.includes("--host");
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = host ? null : targetArg ? targetArg.split("=")[1] : "bun-linux-x64";
const winOut = host ? process.platform === "win32" : !!target && target.includes("windows");
const ext = winOut ? ".exe" : "";

const artifacts = [
  { name: "spectre-core", entry: "src/server/main.ts", cwd: root },
  // The broker pins its OWN deps (zod v3 + MCP SDK) — compile from its dir.
  { name: "spectre-broker", entry: "index.mjs", cwd: resolve(root, "spectre-mcp-broker") },
  { name: "spectre-chat-runner", entry: "worker/chat-runner.mjs", cwd: root },
  { name: "spectre-scheduler", entry: "worker/scheduler.mjs", cwd: root },
  { name: "spectre-channel-runner", entry: "worker/channel-runner.mjs", cwd: root },
];

let failed = false;
for (const a of artifacts) {
  const outfile = resolve(root, "dist", a.name + ext);
  const args = ["build", "--compile"];
  if (target) args.push("--target", target);
  args.push(a.entry, "--outfile", outfile);
  console.log(`[build] ${a.name}  (${target ?? "host"})`);
  const r = spawnSync("bun", args, { cwd: a.cwd, stdio: "inherit" });
  if (r.status !== 0) {
    failed = true;
    console.error(`[build] FAILED: ${a.name}`);
  }
}
console.log(failed ? "[build] DONE WITH ERRORS" : "[build] all binaries built -> dist/");
process.exit(failed ? 1 : 0);
