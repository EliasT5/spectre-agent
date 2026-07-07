/**
 * cli-server process supervisor. A cli-server backend is a command that launches
 * an OpenAI-compatible server (ollama/llama.cpp/vLLM/LM Studio). Spectre either:
 *   - MANAGED (spec.managed=true): spawns + supervises the process on a loopback
 *     port and registers it on LiteLLM. Only viable when the core can actually run
 *     the binary (host-local core, or a lightweight in-container server).
 *   - REGISTER-ONLY (spec.managed=false, the Docker default): the server runs on
 *     the host (user-managed); Spectre just registers it on LiteLLM at
 *     http://{reachableHost}:{port}/v1. The minimal core container can't run GPU
 *     servers, so this is the realistic shipped path.
 *
 * Either way the model then rides the existing OpenAI loop via LiteLLM → full
 * tool-use + streaming + per-message selection.
 */
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { killProcessTree } from "../providers/process-group";
import { cleanEnv } from "./cli-exec";
import { buildCliServerLiteLLMBody } from "./litellm-map";
import { registerModel, deleteModel } from "./litellm-admin";
import type { ModelBackend } from "./schema";

type ServerStatus = "starting" | "running" | "failed" | "stopped";

interface ServerState {
  child?: ChildProcess;
  port: number;
  status: ServerStatus;
  restarts: number;
  litellmModelId?: string;
  error?: string;
}

const servers = new Map<string, ServerState>();
const MAX_RESTARTS = 5;

/** Host the LiteLLM container reaches the server at (host.docker.internal in the shipped stack). */
function reachableHost(): string {
  return process.env.SPECTRE_CLI_SERVER_HOST || "host.docker.internal";
}

function portRange(): [number, number] {
  const raw = process.env.SPECTRE_CLI_SERVER_PORT_RANGE || "8790-8890";
  const [a, b] = raw.split("-").map((n) => parseInt(n, 10));
  return [Number.isFinite(a) ? a : 8790, Number.isFinite(b) ? b : 8890];
}

/** Find a free loopback port within the configured range. */
function pickFreePort(): Promise<number> {
  const [start, end] = portRange();
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > end) return reject(new Error("no free port in SPECTRE_CLI_SERVER_PORT_RANGE"));
      const srv = createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}

function interpolate(s: string, port: number): string {
  return s.replace(/\{port\}/g, String(port));
}

async function healthOk(port: number, healthPath: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, healthPath: string, deadlineMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await healthOk(port, healthPath)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function registerOnGateway(spec: ModelBackend, port: number): Promise<string | undefined> {
  const apiBase = `http://${reachableHost()}:${port}/v1`;
  const res = await registerModel(buildCliServerLiteLLMBody(spec, apiBase));
  if (!res.ok) throw new Error(`gateway rejected cli-server '${spec.id}' (HTTP ${res.status})`);
  return res.litellmModelId;
}

/** Start (or re-register) a single cli-server backend. Idempotent per id. */
export async function startServer(spec: ModelBackend): Promise<ServerState> {
  const existing = servers.get(spec.id);
  if (existing && existing.status === "running") return existing;

  const managed = spec.managed === true;
  let port = spec.port ?? 0;

  if (!managed) {
    // Register-only: the user runs the server on the host at spec.port.
    if (!port) throw new Error(`register-only cli-server '${spec.id}' needs a port`);
    const state: ServerState = { port, status: "starting", restarts: 0 };
    servers.set(spec.id, state);
    try {
      state.litellmModelId = await registerOnGateway(spec, port);
      state.status = "running";
    } catch (e) {
      state.status = "failed";
      state.error = e instanceof Error ? e.message : String(e);
    }
    return state;
  }

  // Managed: spawn + supervise.
  if (!port) port = await pickFreePort();
  const args = (spec.args ?? []).map((a) => interpolate(a, port));
  const env = cleanEnv(
    Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, interpolate(v, port)])),
  );
  const child = spawn(spec.command as string, args, { env, stdio: "ignore", detached: true });
  const state: ServerState = { child, port, status: "starting", restarts: servers.get(spec.id)?.restarts ?? 0 };
  servers.set(spec.id, state);

  child.on("exit", () => {
    const s = servers.get(spec.id);
    if (!s || s.status === "stopped") return;
    s.status = "failed";
    s.child = undefined;
    const policy = spec.restartPolicy ?? "on-failure";
    if (policy !== "never" && s.restarts < MAX_RESTARTS) {
      s.restarts += 1;
      const backoff = Math.min(30_000, 1000 * 2 ** s.restarts);
      setTimeout(() => { void startServer(spec).catch(() => {}); }, backoff);
    } else if (s.restarts >= MAX_RESTARTS) {
      console.warn(`[backends] cli-server '${spec.id}' exceeded ${MAX_RESTARTS} restarts; giving up`);
    }
  });

  // Persist the assigned port so api_base stays stable across restarts.
  if (spec.port !== port) {
    try {
      const { upsertBackend } = await import("./registry");
      await upsertBackend({ ...spec, port });
    } catch { /* non-fatal */ }
  }

  if (!(await waitHealthy(port, spec.healthPath ?? "/v1/models"))) {
    state.status = "failed";
    state.error = "server did not become healthy in time";
    killProcessTree(child);
    return state;
  }
  try {
    state.litellmModelId = await registerOnGateway(spec, port);
    state.status = "running";
  } catch (e) {
    state.status = "failed";
    state.error = e instanceof Error ? e.message : String(e);
  }
  return state;
}

export async function startEnabledServers(list: ModelBackend[]): Promise<void> {
  for (const spec of list) {
    try { await startServer(spec); } catch (e) { console.warn(`[backends] start '${spec.id}' failed:`, e); }
  }
}

export async function stopServer(id: string): Promise<void> {
  const s = servers.get(id);
  if (!s) return;
  s.status = "stopped";
  if (s.child) killProcessTree(s.child);
  if (s.litellmModelId) { try { await deleteModel(s.litellmModelId); } catch { /* best-effort */ } }
  servers.delete(id);
}

export function serverStatus(id: string): { status: ServerStatus; port?: number; error?: string } | undefined {
  const s = servers.get(id);
  return s ? { status: s.status, port: s.port, error: s.error } : undefined;
}

export async function stopAll(): Promise<void> {
  for (const id of [...servers.keys()]) await stopServer(id);
}
