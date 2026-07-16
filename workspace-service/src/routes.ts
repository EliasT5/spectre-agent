/**
 * Workspace HTTP routes (Hono) — dual-mode port of the Spectre-monolith
 * /api/workspace/* Next route handlers.
 *
 * Two slot kinds are unified behind the same routes via SlotManager.resolveRoot():
 *   - SANDBOX: cloned repo under <WORKSPACE_ROOT>/<id>/repo (the monolith model).
 *   - TRUSTED: a real bind-mounted host folder registered in WORKSPACE_TRUSTED_DIRS.
 *
 * Security is unchanged from the monolith: every client path goes through
 * guardPath() (symlink-walk + realpath containment); every subprocess goes
 * through safeSpawn() (shell:false + ENV allowlist + server-injected GH_TOKEN);
 * SSE output goes through the redaction layer.
 *
 * The only behavioural deltas vs. the monolith:
 *   - resolveRoot() returns the working root directly (no more join("repo", …)).
 *   - DELETE / orphans / finalize-with-PR refuse trusted folders.
 *   - finalize on a trusted git repo commits+pushes to its current branch
 *     (no PR, no delete).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute, normalize, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  listAllSlots,
  getSlot,
  claimSlotIndex,
  createSlot,
  updateSlot,
  deleteSlot,
  listOrphanSlotIds,
  resolveRoot,
  type ResolvedRoot,
} from "./lib/slot-manager.js";
import {
  guardPath,
  guardSlotForDeletion,
  PathGuardError,
  WORKSPACE_ROOT,
} from "./lib/path-guard.js";
import { runCommand, safeSpawn } from "./lib/safe-spawn.js";
import { formatSSEEvent } from "./lib/sse-redact.js";

export const workspace = new Hono();

// The GitHub token is set from the Spectre UI (Settings) at runtime and injected
// per-request by the trusted shell proxy as `x-gh-token`. Capture it into a
// request-scoped store so every git/gh spawn picks it up without threading the
// Context through ~20 call sites. Falls back to the GH_TOKEN env for legacy setups.
const ghTokenStore = new AsyncLocalStorage<string | undefined>();
workspace.use("*", async (c, next) => {
  const hdr = c.req.header("x-gh-token");
  await ghTokenStore.run(hdr && hdr.length > 0 ? hdr : undefined, next);
});

// GH token for git/gh spawns: the per-request UI token wins, then the env.
function ghToken(): string | undefined {
  const fromReq = ghTokenStore.getStore();
  if (fromReq && fromReq.length > 0) return fromReq;
  const t = process.env.GH_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

function tail(s: string, n = 600): string {
  return s.length > n ? s.slice(-n) : s;
}

/**
 * Resolve a slot id to its working root, mapping unknown/inaccessible ids to
 * an HTTP-friendly result. Returns either { resolved } or { error, status }.
 */
async function resolve(
  id: string,
): Promise<{ resolved: ResolvedRoot } | { error: string; status: 404 | 400 }> {
  try {
    const resolved = await resolveRoot(id);
    return { resolved };
  } catch (err) {
    const msg = (err as Error).message || "Unknown slot";
    // "Unknown slot" → 404; inaccessible working dir → 400 (mirrors monolith,
    // which 404s on missing metadata and 400s on resolve failures).
    const status: 404 | 400 = /unknown slot/i.test(msg) ? 404 : 400;
    return { error: msg, status };
  }
}

/**
 * Shared list handler. Exported so server.ts can also bind it to the
 * trailing-slash form (/workspace/) directly — Hono maps a sub-app's "/" only
 * to the no-slash mount root (/workspace), so /workspace/ would otherwise 404.
 * Binding the same handler avoids a 301 redirect (which can drop POST bodies).
 */
export const listHandler = (c: Context) => c.json({ slots: listAllSlots() });

workspace.get("/", listHandler);
// Alias: the shell proxy catch-all (/api/workspace/[...path]) can't match the
// bare /api/workspace, so the UI lists slots via /api/workspace/slots.
workspace.get("/slots", listHandler);

interface OpenBody {
  repo?: unknown;
  base_branch?: unknown;
}

const BASE_BRANCH_RE = /^[A-Za-z0-9/_.-]+$/;

function parseRepo(
  input: string,
): { owner: string; name: string; cloneUrl: string } | null {
  // Accept "owner/name" or "https://github.com/owner/name(.git)?".
  const trimmed = input.trim().replace(/\.git$/, "");
  let m = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (m) {
    return {
      owner: m[1],
      name: m[2],
      cloneUrl: `https://github.com/${m[1]}/${m[2]}.git`,
    };
  }
  m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(trimmed);
  if (m) {
    return { owner: m[1], name: m[2], cloneUrl: `${trimmed}.git` };
  }
  return null;
}

function makeBranchName(repoName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const short = Math.random().toString(36).slice(2, 8);
  const slug =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24)
      .replace(/^-|-$/g, "") || "feature";
  return `spectre/${date}-${slug}-${short}`;
}

workspace.post("/open", async (c) => {
  let body: OpenBody;
  try {
    body = (await c.req.json()) as OpenBody;
  } catch {
    body = {};
  }

  // Validate body (mirrors the monolith zod schema: repo 3..256, base_branch
  // matches the safe-ref regex, max 64, default "main").
  const repoRaw = body.repo;
  if (typeof repoRaw !== "string" || repoRaw.length < 3 || repoRaw.length > 256) {
    return c.json({ error: "Invalid body: 'repo' must be a 3-256 char string" }, 400);
  }
  let baseBranch = "main";
  if (body.base_branch !== undefined) {
    if (
      typeof body.base_branch !== "string" ||
      body.base_branch.length > 64 ||
      !BASE_BRANCH_RE.test(body.base_branch)
    ) {
      return c.json({ error: "Invalid body: 'base_branch' is malformed" }, 400);
    }
    baseBranch = body.base_branch;
  }

  // Cloning needs the server-injected GH_TOKEN; fail early with a clear message.
  if (!ghToken()) {
    return c.json(
      {
        error:
          "GH_TOKEN is not configured on the service — cloning a repo requires it. Set GH_TOKEN in the container env.",
      },
      400,
    );
  }

  const repo = parseRepo(repoRaw);
  if (!repo) {
    return c.json(
      {
        error: `Couldn't parse repo "${repoRaw}" — use "owner/name" or full GitHub URL.`,
      },
      400,
    );
  }

  const slotIndex = claimSlotIndex();
  if (slotIndex === null) {
    return c.json(
      { error: "All 3 slots are in use. Discard or finalize a workspace first." },
      409,
    );
  }

  const branch = makeBranchName(repo.name);

  // Create slot dir + meta first so a failed clone shows up as 'failed'.
  const slot = createSlot({
    slot_index: slotIndex,
    repo_url: repo.cloneUrl,
    repo_owner: repo.owner,
    repo_name: repo.name,
    branch,
    base_branch: baseBranch,
    status: "opening",
  });
  const slotDir = join(WORKSPACE_ROOT, slot.id);
  const cloneDir = join(slotDir, "repo");

  const cloneRes = await runCommand(
    "gh",
    ["repo", "clone", `${repo.owner}/${repo.name}`, cloneDir, "--", "--depth=1"],
    { cwd: WORKSPACE_ROOT, timeout: 90_000, ghToken: ghToken() },
  );
  if (cloneRes.code !== 0) {
    updateSlot(slot.id, { status: "failed" });
    return c.json(
      {
        error: `gh clone failed (exit ${cloneRes.code})`,
        stderr_tail: cloneRes.stderr.slice(-600),
      },
      500,
    );
  }

  const branchRes = await runCommand("git", ["checkout", "-b", branch], {
    cwd: cloneDir,
    timeout: 10_000,
    ghToken: ghToken(),
  });
  if (branchRes.code !== 0) {
    updateSlot(slot.id, { status: "failed" });
    return c.json(
      {
        error: "git checkout -b failed",
        stderr_tail: branchRes.stderr.slice(-400),
      },
      500,
    );
  }

  const ready = updateSlot(slot.id, { status: "ready" });
  return c.json({ slot: ready }, 201);
});

workspace.get("/orphans", (c) => {
  return c.json({ ids: listOrphanSlotIds() });
});

workspace.post("/orphans", async (c) => {
  const ids = listOrphanSlotIds();
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      // guardSlotForDeletion is sandbox-only: it requires the realpath to stay
      // under WORKSPACE_ROOT, so a trusted folder can never be nuked here.
      const real = await guardSlotForDeletion(id);
      rmSync(real, { recursive: true, force: true });
      deleted.push(id);
    } catch {
      failed.push(id);
    }
  }
  return c.json({ deleted, failed });
});

workspace.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) {
    // getSlot only knows sandbox slots. A trusted id (or unknown id) is not a
    // deletable sandbox slot.
    return c.json({ error: "Slot not found" }, 404);
  }
  // Guard validates id format + that the realpath resolves under WORKSPACE_ROOT
  // (so a trusted folder can never reach the rm path).
  try {
    await guardSlotForDeletion(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  updateSlot(id, { status: "discarded" });
  deleteSlot(id);
  return c.json({ ok: true });
});

const SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".turbo",
  ".vercel",
]);

interface TreeEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

function walk(root: string, dir: string, out: TreeEntry[], budget = 5000): void {
  if (out.length >= budget) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      out.push({ path: rel, size: 0, is_dir: true });
      walk(root, full, out, budget);
    } else {
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        /* skip */
      }
      out.push({ path: rel, size, is_dir: false });
    }
    if (out.length >= budget) return;
  }
}

workspace.get("/:id/tree", async (c) => {
  const id = c.req.param("id");
  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const repoDir = r.resolved.root;
  const out: TreeEntry[] = [];
  try {
    walk(repoDir, repoDir, out);
  } catch (err) {
    return c.json(
      { error: `tree walk failed: ${(err as Error).message}` },
      500,
    );
  }
  return c.json({ files: out });
});

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

workspace.get("/:id/file", async (c) => {
  const id = c.req.param("id");
  const relPath = c.req.query("path");
  if (!relPath) return c.json({ error: "Missing ?path=" }, 400);

  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  let abs: string;
  try {
    abs = await guardPath(r.resolved.root, relPath);
  } catch (err) {
    if (err instanceof PathGuardError) return c.json({ error: err.message }, 400);
    return c.json({ error: (err as Error).message }, 500);
  }

  let content: Buffer;
  try {
    content = await readFile(abs);
  } catch (err) {
    return c.json({ error: `Read failed: ${(err as Error).message}` }, 404);
  }

  if (content.byteLength > MAX_BYTES) {
    return c.json(
      { error: "File too large for editor (>2 MB)", size: content.byteLength },
      413,
    );
  }

  // Binary heuristic mirrors the monolith: a NUL byte ( ) → treat as binary.
  const text = content.toString("utf-8");
  const looksBinary = text.includes(" ");
  return new Response(looksBinary ? null : text, {
    status: 200,
    headers: {
      "Content-Type": looksBinary
        ? "application/octet-stream"
        : "text/plain; charset=utf-8",
      "X-File-Size": String(content.byteLength),
      "X-File-Binary": looksBinary ? "1" : "0",
    },
  });
});

workspace.put("/:id/file", async (c) => {
  const id = c.req.param("id");
  const relPath = c.req.query("path");
  if (!relPath) return c.json({ error: "Missing ?path=" }, 400);

  const text = await c.req.text();
  if (Buffer.byteLength(text) > MAX_BYTES) {
    return c.json({ error: "File too large (>2 MB)" }, 413);
  }

  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  let abs: string;
  try {
    abs = await guardPath(r.resolved.root, relPath);
  } catch (err) {
    if (err instanceof PathGuardError) return c.json({ error: err.message }, 400);
    return c.json({ error: (err as Error).message }, 500);
  }
  try {
    await writeFile(abs, text, "utf-8");
  } catch (err) {
    return c.json({ error: `Write failed: ${(err as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});

type DiffStatus = "M" | "A" | "D" | "U";

interface ChangedFile {
  path: string;
  status: DiffStatus;
}

function normalizeStatus(raw: string): DiffStatus {
  if (raw.includes("U")) return "U";
  if (raw.includes("A") || raw === "??") return "A";
  if (raw.includes("D")) return "D";
  return "M";
}

function parseStatus(stdout: string): ChangedFile[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawStatus = line.slice(0, 2);
      const rawPath = line.slice(3);
      const path = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop() ?? rawPath
        : rawPath;
      return { path, status: normalizeStatus(rawStatus) };
    });
}

function validateRepoRelPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  ) {
    throw new PathGuardError("Invalid path");
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new PathGuardError("Path traversal detected");
  }
  return normalized;
}

async function getStatus(
  repoDir: string,
  path: string,
): Promise<DiffStatus | null> {
  const res = await runCommand(
    "git",
    ["status", "--porcelain", "--", path],
    { cwd: repoDir, timeout: 15_000, ghToken: ghToken() },
  );
  if (res.code !== 0) throw new Error(res.stderr || "git status failed");
  return parseStatus(res.stdout)[0]?.status ?? null;
}

workspace.get("/:id/diff", async (c) => {
  const id = c.req.param("id");
  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const repoDir = r.resolved.root;
  const relPath = c.req.query("path");

  if (!relPath) {
    try {
      const status = await runCommand("git", ["status", "--porcelain"], {
        cwd: repoDir,
        timeout: 15_000,
        ghToken: ghToken(),
      });
      if (status.code !== 0) {
        return c.json(
          { error: status.stderr || "git status failed" },
          500,
        );
      }
      return c.json({ files: parseStatus(status.stdout) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  let safeRelPath: string;
  try {
    safeRelPath = validateRepoRelPath(relPath);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  let abs: string;
  try {
    abs = await guardPath(repoDir, safeRelPath);
  } catch (err) {
    if (err instanceof PathGuardError) return c.json({ error: err.message }, 400);
    return c.json({ error: (err as Error).message }, 500);
  }

  try {
    const status = await getStatus(repoDir, safeRelPath);
    const isNew = status === "A" || status === "U";
    const before = isNew
      ? null
      : await runCommand("git", ["show", `HEAD:${safeRelPath}`], {
          cwd: repoDir,
          timeout: 15_000,
          ghToken: ghToken(),
        }).then((res) => {
          if (res.code !== 0) return null;
          return res.stdout;
        });
    // Read the realpath-validated path returned by guardPath (mirrors the
    // monolith, which read from the guarded abs rather than re-joining).
    const after = status === "D" ? "" : await readFile(abs, "utf-8");
    return c.json({ before, after });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

interface RgSubmatch {
  match?: { text?: string };
  start?: number;
  end?: number;
}

interface RgMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: RgSubmatch[];
  };
}

interface SearchResult {
  path: string;
  line: number;
  col: number;
  text: string;
  matched: string;
}

function parseMax(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : 50;
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function parseRgJson(stdout: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of stdout.split("\n")) {
    if (results.length >= max || !line.trim()) continue;
    let entry: RgMatch;
    try {
      entry = JSON.parse(line) as RgMatch;
    } catch {
      continue;
    }
    if (entry.type !== "match") continue;
    const data = entry.data;
    const firstMatch = data?.submatches?.[0];
    const path = data?.path?.text;
    const lineNumber = data?.line_number;
    const text = data?.lines?.text;
    const matched = firstMatch?.match?.text;
    if (
      !path ||
      typeof lineNumber !== "number" ||
      text === undefined ||
      !matched
    )
      continue;
    results.push({
      path,
      line: lineNumber,
      col: (firstMatch.start ?? 0) + 1,
      text: text.replace(/\r?\n$/, ""),
      matched,
    });
  }
  return results;
}

workspace.get("/:id/search", async (c) => {
  const id = c.req.param("id");
  const query = c.req.query("q") ?? "";
  if (!query.trim() || query.length > 200) {
    return c.json({ error: "q must be 1-200 characters" }, 400);
  }
  const max = parseMax(c.req.query("max") ?? null);

  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  try {
    const res = await runCommand(
      "rg",
      ["--json", "--max-count=10", "--no-heading", query],
      { cwd: r.resolved.root, timeout: 15_000, ghToken: ghToken() },
    );
    if (res.code !== 0 && res.code !== 1) {
      return c.json({ error: res.stderr || "ripgrep failed" }, 500);
    }
    return c.json({ results: parseRgJson(res.stdout, max) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const TRAVERSAL_RE = /cd\s+\/|cd\s+\.\./;

workspace.post("/:id/shell", async (c) => {
  const id = c.req.param("id");
  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  // Sandbox slots must be 'ready'; trusted folders are always ready.
  if (r.resolved.kind === "sandbox" && r.resolved.meta.status !== "ready") {
    return c.json({ error: `Slot is ${r.resolved.meta.status}` }, 409);
  }

  let body: { cmd?: unknown };
  try {
    body = (await c.req.json()) as { cmd?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.cmd !== "string" || !body.cmd.trim()) {
    return c.json({ error: "cmd must be a non-empty string" }, 400);
  }

  const cmd = body.cmd.trim();

  if (TRAVERSAL_RE.test(cmd)) {
    return c.json(
      {
        error:
          "Commands containing 'cd /' or 'cd ..' are not allowed (path-traversal prevention).",
      },
      400,
    );
  }

  const cwd = r.resolved.root;

  // streamSSE sets the text/event-stream + no-cache + keep-alive headers itself
  // and closes the stream when this callback's promise resolves.
  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve) => {
      const child = safeSpawn("bash", ["-lc", cmd], { cwd, ghToken: ghToken() });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      function send(data: Record<string, unknown>) {
        // formatSSEEvent already builds the full frame (with redaction); write
        // it raw so the redaction + 4096 cap is applied exactly once.
        void stream.write(formatSSEEvent("message", data));
      }

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        send({ type: "done", code: null, error: "Command timed out after 4 minutes" });
        finish();
      }, 4 * 60 * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        send({ type: "stdout", chunk: chunk.toString("utf8") });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        send({ type: "stderr", chunk: chunk.toString("utf8") });
      });
      child.on("error", (err: Error) => {
        send({ type: "done", code: null, error: err.message });
        finish();
      });
      child.on("close", (code: number | null) => {
        send({ type: "done", code });
        finish();
      });
    });
  });
});

type Phase = "install" | "test";

function npmInstallArgs(repoDir: string): string[] {
  if (existsSync(join(repoDir, "package-lock.json"))) return ["ci"];
  return ["install"];
}

function hasPackageJson(repoDir: string): boolean {
  const packagePath = join(repoDir, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    JSON.parse(readFileSync(packagePath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

workspace.post("/:id/run-tests", async (c) => {
  const id = c.req.param("id");
  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  if (r.resolved.kind === "sandbox" && r.resolved.meta.status !== "ready") {
    return c.json(
      { error: `Slot is ${r.resolved.meta.status}, must be 'ready' to run tests` },
      409,
    );
  }

  const repoDir = r.resolved.root;
  const isSandbox = r.resolved.kind === "sandbox";

  // last_test_status is sandbox-only metadata (trusted folders have no
  // .workspace.json to persist to).
  if (isSandbox) updateSlot(id, { last_test_status: "pending" });

  // streamSSE sets the SSE headers and closes the stream when this callback
  // resolves; the install/test promises keep it open until both phases finish.
  return streamSSE(c, async (stream) => {
    function send(event: string, data: unknown) {
      void stream.write(formatSSEEvent(event, data));
    }

    function runProcess(
      phase: Phase,
      cmd: string,
      args: string[],
    ): Promise<number | null> {
      return new Promise((resolveProc, rejectProc) => {
        send("phase", { phase, status: "running" });
        const child = safeSpawn(cmd, args, { cwd: repoDir, ghToken: ghToken() });
        child.stdout?.on("data", (chunk: Buffer) => {
          send("log", {
            phase,
            status: "running",
            stream: "stdout",
            chunk: chunk.toString("utf8"),
          });
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          send("log", {
            phase,
            status: "running",
            stream: "stderr",
            chunk: chunk.toString("utf8"),
          });
        });
        child.on("error", rejectProc);
        child.on("close", (code) => resolveProc(code));
      });
    }

    try {
      if (!hasPackageJson(repoDir)) {
        if (isSandbox) updateSlot(id, { last_test_status: "skipped" });
        send("error", {
          phase: "test",
          status: "failing",
          message: "No package.json found in workspace repo.",
        });
        return;
      }

      const installCode = await runProcess(
        "install",
        "npm",
        npmInstallArgs(repoDir),
      );
      if (installCode !== 0) {
        if (isSandbox) updateSlot(id, { last_test_status: "failing" });
        send("done", { phase: "install", status: "failing", code: installCode });
        return;
      }

      const testCode = await runProcess("test", "npm", ["test"]);
      if (isSandbox) {
        updateSlot(id, {
          last_test_status: testCode === 0 ? "passing" : "failing",
        });
      }
      send("done", {
        phase: "test",
        status: testCode === 0 ? "passing" : "failing",
        code: testCode,
      });
    } catch (err) {
      if (isSandbox) updateSlot(id, { last_test_status: "failing" });
      send("error", {
        phase: "test",
        status: "failing",
        message: (err as Error).message,
      });
    }
  });
});

interface FinalizeBody {
  title?: unknown;
  body?: unknown;
  message?: unknown;
}

function parseFinalizeBody(
  raw: FinalizeBody,
): { title: string; body: string; message: string } | { error: string } {
  // Mirrors the monolith zod schema: title 1..200, body max 8000 (default ""),
  // message 1..500 (default "Changes from Spectre workspace").
  const title = raw.title;
  if (typeof title !== "string" || title.length < 1 || title.length > 200) {
    return { error: "Invalid body: 'title' must be 1-200 chars" };
  }
  let body = "";
  if (raw.body !== undefined) {
    if (typeof raw.body !== "string" || raw.body.length > 8000) {
      return { error: "Invalid body: 'body' must be a string up to 8000 chars" };
    }
    body = raw.body;
  }
  let message = "Changes from Spectre workspace";
  if (raw.message !== undefined) {
    if (
      typeof raw.message !== "string" ||
      raw.message.length < 1 ||
      raw.message.length > 500
    ) {
      return { error: "Invalid body: 'message' must be 1-500 chars" };
    }
    message = raw.message;
  }
  return { title, body, message };
}

// Spectre signs its own git work as the collaborator (not the underlying AI CLI).
// Author identity + a co-author trailer + a PR credit line linking the agent repo.
// Point the email at a Spectre GitHub account's no-reply address for a linked avatar.
const SPECTRE_GIT_EMAIL = "spectre@users.noreply.github.com";
const SPECTRE_COAUTHOR = "Co-Authored-By: Spectre <spectre@users.noreply.github.com>";
const SPECTRE_PR_CREDIT = "Via [Spectre](https://github.com/EliasT5/spectre-agent)";

workspace.post("/:id/finalize", async (c) => {
  const id = c.req.param("id");
  const r = await resolve(id);
  if ("error" in r) return c.json({ error: r.error }, r.status);

  let raw: FinalizeBody;
  try {
    raw = (await c.req.json()) as FinalizeBody;
  } catch {
    raw = {};
  }

  if (r.resolved.kind === "trusted") {
    const repoDir = r.resolved.root;

    // Must be inside a git work tree.
    const isRepo = await runCommand(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repoDir, timeout: 15_000, ghToken: ghToken() },
    );
    if (isRepo.code !== 0 || isRepo.stdout.trim() !== "true") {
      return c.json(
        { error: "Trusted folder is not a git repository — nothing to finalize." },
        400,
      );
    }

    // Validate optional commit message (reuse the finalize body shape, but
    // title/body/PR fields are ignored for trusted).
    let message = "Changes from Spectre workspace";
    if (raw.message !== undefined) {
      if (
        typeof raw.message !== "string" ||
        raw.message.length < 1 ||
        raw.message.length > 500
      ) {
        return c.json({ error: "Invalid body: 'message' must be 1-500 chars" }, 400);
      }
      message = raw.message;
    }

    // Determine current branch (needed for the push refspec).
    const branchRes = await runCommand(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, timeout: 15_000, ghToken: ghToken() },
    );
    if (branchRes.code !== 0) {
      return c.json(
        { error: "git rev-parse failed", stderr_tail: tail(branchRes.stderr) },
        500,
      );
    }
    const branch = branchRes.stdout.trim();
    if (!branch || branch === "HEAD") {
      return c.json(
        { error: "Trusted folder is in a detached HEAD state — cannot push." },
        400,
      );
    }

    // Commit only if dirty.
    const status = await runCommand("git", ["status", "--porcelain"], {
      cwd: repoDir,
      timeout: 15_000,
      ghToken: ghToken(),
    });
    if (status.code !== 0) {
      return c.json(
        { error: "git status failed", stderr_tail: tail(status.stderr) },
        500,
      );
    }
    if (status.stdout.trim().length > 0) {
      const stage = await runCommand("git", ["add", "-A"], {
        cwd: repoDir,
        timeout: 30_000,
        ghToken: ghToken(),
      });
      if (stage.code !== 0) {
        return c.json(
          { error: "git add failed", stderr_tail: tail(stage.stderr) },
          500,
        );
      }
      const commit = await runCommand(
        "git",
        [
          "-c",
          `user.email=${SPECTRE_GIT_EMAIL}`,
          "-c",
          "user.name=Spectre",
          "commit",
          "-m",
          `${message}\n\n${SPECTRE_COAUTHOR}`,
        ],
        { cwd: repoDir, timeout: 30_000, ghToken: ghToken() },
      );
      if (commit.code !== 0) {
        return c.json(
          { error: "git commit failed", stderr_tail: tail(commit.stderr) },
          500,
        );
      }
    }

    // Push to the current branch's upstream (origin <branch>).
    const push = await runCommand("git", ["push", "origin", branch], {
      cwd: repoDir,
      timeout: 90_000,
      ghToken: ghToken(),
    });
    if (push.code !== 0) {
      return c.json(
        { error: "git push failed", stderr_tail: tail(push.stderr) },
        500,
      );
    }

    return c.json({ pushed: true, branch }, 200);
  }

  const slot = r.resolved.meta;
  if (slot.status !== "ready") {
    return c.json(
      { error: `Slot is ${slot.status}, must be 'ready' to finalize` },
      409,
    );
  }

  const parsed = parseFinalizeBody(raw);
  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }
  const { title, body: prBody, message } = parsed;

  // Mark in-flight so a retry / discard can't race us.
  updateSlot(id, { status: "finalizing" });

  const repoDir = r.resolved.root;

  const fail = (step: string, stderr: string) => {
    // Revert to 'ready', not 'failed': the repo on disk is intact and the finalize
    // is safe to retry. A 'failed' slot was un-actionable in the UI (no editor, no
    // retry — it just 409s), which read as a "stale slot with no repo".
    updateSlot(id, { status: "ready" });
    return c.json({ error: `${step} failed`, stderr_tail: tail(stderr) }, 500);
  };

  // 1. Status — only commit if dirty.
  const status = await runCommand("git", ["status", "--porcelain"], {
    cwd: repoDir,
    timeout: 15_000,
    ghToken: ghToken(),
  });
  if (status.code !== 0) return fail("git status", status.stderr);

  if (status.stdout.trim().length > 0) {
    const stage = await runCommand("git", ["add", "-A"], {
      cwd: repoDir,
      timeout: 30_000,
      ghToken: ghToken(),
    });
    if (stage.code !== 0) return fail("git add", stage.stderr);
    const commit = await runCommand(
      "git",
      [
        "-c",
        "user.email=spectre@local.invalid",
        "-c",
        "user.name=Spectre",
        "commit",
        "-m",
        message,
      ],
      { cwd: repoDir, timeout: 30_000, ghToken: ghToken() },
    );
    if (commit.code !== 0) return fail("git commit", commit.stderr);
  }

  // 2. Push the branch upstream.
  const push = await runCommand("git", ["push", "-u", "origin", slot.branch], {
    cwd: repoDir,
    timeout: 90_000,
    ghToken: ghToken(),
  });
  if (push.code !== 0) return fail("git push", push.stderr);

  // 3. Open PR via gh CLI (GH_TOKEN injected by safe-spawn).
  const pr = await runCommand(
    "gh",
    [
      "pr",
      "create",
      "--base",
      slot.base_branch,
      "--head",
      slot.branch,
      "--title",
      title,
      "--body",
      prBody ? `${prBody}\n\n---\n${SPECTRE_PR_CREDIT}` : SPECTRE_PR_CREDIT,
    ],
    { cwd: repoDir, timeout: 60_000, ghToken: ghToken() },
  );
  if (pr.code !== 0) return fail("gh pr create", pr.stderr);
  const urlMatch = /https?:\/\/github\.com\/[^\s]+/.exec(pr.stdout);
  const prUrl = urlMatch ? urlMatch[0].replace(/[.,]+$/, "") : null;

  // 4. Persist PR URL + status BEFORE rm so a crash can't lose the URL.
  updateSlot(id, { status: "finalized", pr_url: prUrl });

  // 5. Wipe the slot.
  deleteSlot(id);

  return c.json({ pr_url: prUrl, branch: slot.branch }, 200);
});
