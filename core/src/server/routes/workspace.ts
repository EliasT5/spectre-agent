import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute, normalize, relative, sep } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  claimSlotIndex,
  createSlot,
  deleteSlot,
  getSlot,
  listOrphanSlotIds,
  listSlots,
  type SlotMetadata,
  updateSlot,
} from "@/lib/workspace-server/slot-manager";
import {
  guardPath,
  guardSlotForDeletion,
  PathGuardError,
  resolveSlotRoot,
  WORKSPACE_ROOT,
} from "@/lib/workspace-server/path-guard";
import { runCommand, safeSpawn } from "@/lib/workspace-server/safe-spawn";
import { formatSSEEvent } from "@/lib/workspace-server/sse-redact";

export const workspace = new Hono();

const OpenSchema = z.object({
  repo: z.string().min(3).max(256),
  base_branch: z.string().regex(/^[A-Za-z0-9/_.-]+$/).max(64).default("main"),
});

const FinalizeSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(8000).default(""),
  message: z.string().min(1).max(500).default("Changes from Jerome workspace"),
});

type DiffStatus = "M" | "A" | "D" | "U";
type Phase = "install" | "test";

interface ChangedFile {
  path: string;
  status: DiffStatus;
}

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

interface TreeEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

const FILE_MAX_BYTES = 2 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".next", "dist", ".turbo", ".vercel"]);
const TRAVERSAL_RE = /cd\s+\/|cd\s+\.\./;

function parseRepo(input: string): { owner: string; name: string; cloneUrl: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  let m = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  if (m) {
    return { owner: m[1], name: m[2], cloneUrl: `https://github.com/${m[1]}/${m[2]}.git` };
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
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24).replace(/^-|-$/g, "") || "feature";
  return `jerome/${date}-${slug}-${short}`;
}

function tail(s: string, n = 600): string {
  return s.length > n ? s.slice(-n) : s;
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
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
      return { path, status: normalizeStatus(rawStatus) };
    });
}

function validateRepoRelPath(path: string): string {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    throw new PathGuardError("Invalid path");
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new PathGuardError("Path traversal detected");
  }
  return normalized;
}

async function getStatus(repoDir: string, path: string): Promise<DiffStatus | null> {
  const res = await runCommand("git", ["status", "--porcelain", "--", path], {
    cwd: repoDir,
    timeout: 15_000,
  });
  if (res.code !== 0) throw new Error(res.stderr || "git status failed");
  return parseStatus(res.stdout)[0]?.status ?? null;
}

function parseMax(raw: string | undefined): number {
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
    if (!path || typeof lineNumber !== "number" || text === undefined || !matched) continue;
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
        // skip
      }
      out.push({ path: rel, size, is_dir: false });
    }
    if (out.length >= budget) return;
  }
}

function safeEnv(): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "NODE_PATH"];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

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

async function runTestProcess(
  stream: { write: (input: string) => Promise<unknown> },
  phase: Phase,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    void stream.write(formatSSEEvent("phase", { phase, status: "running" }));

    const child = spawn(cmd, args, {
      cwd,
      env: safeEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      void stream.write(formatSSEEvent("log", {
        phase,
        status: "running",
        stream: "stdout",
        chunk: chunk.toString("utf8"),
      }));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      void stream.write(formatSSEEvent("log", {
        phase,
        status: "running",
        stream: "stderr",
        chunk: chunk.toString("utf8"),
      }));
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

workspace.get("/", (c) => {
  const taken = listSlots();
  const byIndex = new Map<number, SlotMetadata>(taken.map((s) => [s.slot_index, s]));
  const slots = [1, 2, 3].map((i) => byIndex.get(i) ?? null);
  return c.json({ slots });
});

workspace.post("/open", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = OpenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);
  }
  const repo = parseRepo(parsed.data.repo);
  if (!repo) {
    return c.json({ error: `Couldn't parse repo "${parsed.data.repo}" — use "owner/name" or full GitHub URL.` }, 400);
  }

  const slotIndex = claimSlotIndex();
  if (slotIndex === null) {
    return c.json({ error: "All 3 slots are in use. Discard or finalize a workspace first." }, 409);
  }

  const branch = makeBranchName(repo.name);
  const slot = createSlot({
    slot_index: slotIndex,
    repo_url: repo.cloneUrl,
    repo_owner: repo.owner,
    repo_name: repo.name,
    branch,
    base_branch: parsed.data.base_branch,
    status: "opening",
  });
  const slotDir = join(WORKSPACE_ROOT, slot.id);
  const cloneDir = join(slotDir, "repo");
  const cloneRes = await runCommand("gh", ["repo", "clone", `${repo.owner}/${repo.name}`, cloneDir, "--", "--depth=1"], {
    cwd: WORKSPACE_ROOT,
    timeout: 90_000,
  });
  if (cloneRes.code !== 0) {
    updateSlot(slot.id, { status: "failed" });
    return c.json({ error: `gh clone failed (exit ${cloneRes.code})`, stderr_tail: cloneRes.stderr.slice(-600) }, 500);
  }

  const branchRes = await runCommand("git", ["checkout", "-b", branch], {
    cwd: cloneDir,
    timeout: 10_000,
  });
  if (branchRes.code !== 0) {
    updateSlot(slot.id, { status: "failed" });
    return c.json({ error: `git checkout -b failed`, stderr_tail: branchRes.stderr.slice(-400) }, 500);
  }

  const ready = updateSlot(slot.id, { status: "ready" });
  return c.json({ slot: ready }, 201);
});

workspace.get("/orphans", (c) => c.json({ ids: listOrphanSlotIds() }));

workspace.post("/orphans", async (c) => {
  const ids = listOrphanSlotIds();
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      const real = await guardSlotForDeletion(id);
      rmSync(real, { recursive: true, force: true });
      deleted.push(id);
    } catch {
      failed.push(id);
    }
  }
  return c.json({ deleted, failed });
});

workspace.get("/threads", async (c) => {
  const repo = c.req.query("repo");
  if (!repo) {
    return c.json({ error: "repo query param required" }, 400);
  }

  const escaped = repo.replace(/([\\%_])/g, "\\$1");
  const expectedPrefix = `Workspace: ${repo} @`;

  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("threads")
    .select("*")
    .eq("archived", false)
    .ilike("title", `Workspace: ${escaped} @%`)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) return c.json({ error: error.message }, 500);

  const filtered = (data ?? []).filter(
    (t: { title: string | null }) => typeof t.title === "string" && t.title.startsWith(expectedPrefix),
  );
  return c.json(filtered);
});

workspace.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);
  try {
    await guardSlotForDeletion(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  updateSlot(id, { status: "discarded" });
  deleteSlot(id);
  return c.json({ ok: true });
});

workspace.get("/:id/diff", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);

  let slotRoot: string;
  try {
    slotRoot = await resolveSlotRoot(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const repoDir = join(slotRoot, "repo");
  const relPath = c.req.query("path");

  if (!relPath) {
    try {
      const status = await runCommand("git", ["status", "--porcelain"], {
        cwd: repoDir,
        timeout: 15_000,
      });
      if (status.code !== 0) {
        return c.json({ error: status.stderr || "git status failed" }, 500);
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
    abs = await guardPath(id, join("repo", safeRelPath));
  } catch (err) {
    if (err instanceof PathGuardError) {
      return c.json({ error: err.message }, 400);
    }
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
        }).then((res) => {
          if (res.code !== 0) return null;
          return res.stdout;
        });
    const after = status === "D" ? "" : await readFile(abs, "utf-8");
    return c.json({ before, after });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

workspace.get("/:id/file", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);

  const relPath = c.req.query("path");
  if (!relPath) return c.json({ error: "Missing ?path=" }, 400);

  let abs: string;
  try {
    abs = await guardPath(id, join("repo", relPath));
  } catch (err) {
    if (err instanceof PathGuardError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: (err as Error).message }, 500);
  }

  let content: Buffer;
  try {
    content = await readFile(abs);
  } catch (err) {
    return c.json({ error: `Read failed: ${(err as Error).message}` }, 404);
  }

  if (content.byteLength > FILE_MAX_BYTES) {
    return c.json({ error: "File too large for editor (>2 MB)", size: content.byteLength }, 413);
  }

  const text = content.toString("utf-8");
  const looksBinary = text.includes("\0");
  const headers = {
    "Content-Type": looksBinary ? "application/octet-stream" : "text/plain; charset=utf-8",
    "X-File-Size": String(content.byteLength),
    "X-File-Binary": looksBinary ? "1" : "0",
  };
  if (looksBinary) {
    return c.body(null, 200, headers);
  }
  return c.body(text, 200, {
    "Content-Type": looksBinary ? "application/octet-stream" : "text/plain; charset=utf-8",
    "X-File-Size": String(content.byteLength),
    "X-File-Binary": looksBinary ? "1" : "0",
  });
});

workspace.put("/:id/file", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);

  const relPath = c.req.query("path");
  if (!relPath) return c.json({ error: "Missing ?path=" }, 400);

  const text = await c.req.text();
  if (Buffer.byteLength(text) > FILE_MAX_BYTES) {
    return c.json({ error: "File too large (>2 MB)" }, 413);
  }

  let abs: string;
  try {
    abs = await guardPath(id, join("repo", relPath));
  } catch (err) {
    if (err instanceof PathGuardError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
  try {
    await writeFile(abs, text, "utf-8");
  } catch (err) {
    return c.json({ error: `Write failed: ${(err as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});

workspace.post("/:id/finalize", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);
  if (slot.status !== "ready") {
    return c.json({ error: `Slot is ${slot.status}, must be 'ready' to finalize` }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = FinalizeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);
  }
  const { title, body: prBody, message } = parsed.data;

  updateSlot(id, { status: "finalizing" });

  let slotRoot: string;
  try {
    slotRoot = await resolveSlotRoot(id);
  } catch (err) {
    updateSlot(id, { status: "failed" });
    return c.json({ error: (err as Error).message }, 400);
  }
  const repoDir = join(slotRoot, "repo");

  const status = await runCommand("git", ["status", "--porcelain"], { cwd: repoDir, timeout: 15_000 });
  if (status.code !== 0) {
    updateSlot(id, { status: "failed" });
    return c.json({ error: "git status failed", stderr_tail: tail(status.stderr) }, 500);
  }

  if (status.stdout.trim().length > 0) {
    const stage = await runCommand("git", ["add", "-A"], { cwd: repoDir, timeout: 30_000 });
    if (stage.code !== 0) {
      updateSlot(id, { status: "failed" });
      return c.json({ error: "git add failed", stderr_tail: tail(stage.stderr) }, 500);
    }
    const commit = await runCommand(
      "git",
      ["-c", "user.email=jerome@local.invalid", "-c", "user.name=Jerome", "commit", "-m", message],
      { cwd: repoDir, timeout: 30_000 },
    );
    if (commit.code !== 0) {
      updateSlot(id, { status: "failed" });
      return c.json({ error: "git commit failed", stderr_tail: tail(commit.stderr) }, 500);
    }
  }

  const push = await runCommand("git", ["push", "-u", "origin", slot.branch], { cwd: repoDir, timeout: 90_000 });
  if (push.code !== 0) {
    updateSlot(id, { status: "failed" });
    return c.json({ error: "git push failed", stderr_tail: tail(push.stderr) }, 500);
  }

  const pr = await runCommand(
    "gh",
    ["pr", "create", "--base", slot.base_branch, "--head", slot.branch, "--title", title, "--body", prBody || "Created via Jerome Workspaces."],
    { cwd: repoDir, timeout: 60_000 },
  );
  if (pr.code !== 0) {
    updateSlot(id, { status: "failed" });
    return c.json({ error: "gh pr create failed", stderr_tail: tail(pr.stderr) }, 500);
  }
  const urlMatch = /https?:\/\/github\.com\/[^\s]+/.exec(pr.stdout);
  const prUrl = urlMatch ? urlMatch[0].replace(/[.,]+$/, "") : null;

  updateSlot(id, { status: "finalized", pr_url: prUrl });
  deleteSlot(id);

  return c.json({ pr_url: prUrl, branch: slot.branch }, 200);
});

workspace.post("/:id/run-tests", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);
  if (slot.status !== "ready") {
    return c.json({ error: `Slot is ${slot.status}, must be 'ready' to run tests` }, 409);
  }

  let repoDir: string;
  try {
    repoDir = join(await resolveSlotRoot(id), "repo");
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  updateSlot(id, { last_test_status: "pending" });

  return streamSSE(c, async (stream) => {
    function send(event: string, data: unknown) {
      return stream.write(formatSSEEvent(event, data));
    }

    try {
      if (!hasPackageJson(repoDir)) {
        updateSlot(id, { last_test_status: "skipped" });
        await send("error", { phase: "test", status: "failing", message: "No package.json found in workspace repo." });
        return;
      }

      const installCode = await runTestProcess(stream, "install", "npm", npmInstallArgs(repoDir), repoDir);
      if (installCode !== 0) {
        updateSlot(id, { last_test_status: "failing" });
        await send("done", { phase: "install", status: "failing", code: installCode });
        return;
      }

      const testCode = await runTestProcess(stream, "test", "npm", ["test"], repoDir);
      updateSlot(id, { last_test_status: testCode === 0 ? "passing" : "failing" });
      await send("done", { phase: "test", status: testCode === 0 ? "passing" : "failing", code: testCode });
    } catch (err) {
      updateSlot(id, { last_test_status: "failing" });
      await send("error", { phase: "test", status: "failing", message: (err as Error).message });
    }
  });
});

workspace.get("/:id/search", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);

  const query = c.req.query("q") ?? "";
  if (!query.trim() || query.length > 200) {
    return c.json({ error: "q must be 1-200 characters" }, 400);
  }
  const max = parseMax(c.req.query("max"));

  let slotRoot: string;
  try {
    slotRoot = await resolveSlotRoot(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  try {
    const res = await runCommand("rg", ["--json", "--max-count=10", "--no-heading", query], {
      cwd: join(slotRoot, "repo"),
      timeout: 15_000,
    });
    if (res.code !== 0 && res.code !== 1) {
      return c.json({ error: res.stderr || "ripgrep failed" }, 500);
    }
    return c.json({ results: parseRgJson(res.stdout, max) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

workspace.post("/:id/shell", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) return c.json({ error: "Slot not found" }, 404);
  if (slot.status !== "ready") {
    return c.json({ error: `Slot is ${slot.status}` }, 409);
  }

  let body: { cmd?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.cmd !== "string" || !body.cmd.trim()) {
    return c.json({ error: "cmd must be a non-empty string" }, 400);
  }

  const cmd = body.cmd.trim();

  if (TRAVERSAL_RE.test(cmd)) {
    return c.json({ error: "Commands containing 'cd /' or 'cd ..' are not allowed (path-traversal prevention)." }, 400);
  }

  let slotRoot: string;
  try {
    slotRoot = await resolveSlotRoot(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const cwd = join(slotRoot, "repo");

  return streamSSE(c, async (stream) => {
    function send(data: Record<string, unknown>) {
      return stream.write(formatSSEEvent("message", data));
    }

    const child = safeSpawn("bash", ["-lc", cmd], { cwd });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      void send({ type: "done", code: null, error: "Command timed out after 4 minutes" });
    }, 4 * 60 * 1000);

    const done = new Promise<void>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        void send({ type: "stdout", chunk: chunk.toString("utf8") });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        void send({ type: "stderr", chunk: chunk.toString("utf8") });
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        void send({ type: "done", code: null, error: err.message }).finally(resolve);
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        void send({ type: "done", code }).finally(resolve);
      });
    });

    while (!stream.aborted) {
      await Promise.race([done, stream.sleep(250)]);
      if (child.exitCode !== null || child.killed) break;
    }
    if (stream.aborted) child.kill("SIGTERM");
  });
});

workspace.get("/:id/tree", async (c) => {
  const id = c.req.param("id");
  const slot = getSlot(id);
  if (!slot) {
    return c.json({ error: "Slot not found" }, 404);
  }
  let slotRoot: string;
  try {
    slotRoot = await resolveSlotRoot(id);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const repoDir = join(slotRoot, "repo");
  const out: TreeEntry[] = [];
  try {
    walk(repoDir, repoDir, out);
  } catch (err) {
    return c.json({ error: `tree walk failed: ${(err as Error).message}` }, 500);
  }
  return c.json({ files: out });
});
