/**
 * OpenAI GPT tools via Codex CLI — no API key required, uses ChatGPT Plus subscription.
 *
 * Tools:
 *   openai.image  — image generation via Codex CLI's built-in image_gen tool
 *   openai.chat   — GPT subagent (gpt-5.5, gpt-5.4-mini, gpt-5.3-codex, etc.) via codex exec
 *
 * Both invoke `codex exec --full-auto --json --ephemeral --skip-git-repo-check`
 * and parse the JSONL output stream. No OPENAI_API_KEY required — uses the
 * ChatGPT Plus subscription bound at `codex login --device-auth` time.
 *
 * JSONL events parsed (same as src/lib/ai/providers/codex-cli.ts):
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}  → text
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}} → usage
 *
 * Image files: Codex's image_gen tool saves to $CODEX_HOME/generated_images/.
 * We snapshot that dir before the call, detect new files after, copy them to
 * PUBLIC_GENERATED (served by Next.js standalone at /generated/<uuid>.ext).
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, readdir, copyFile, stat, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

const errResult = (text) => ({ isError: true, content: [{ type: "text", text }] });

const CODEX_BIN = process.env.CODEX_CLI_BIN || "codex";
const CODEX_HOME =
  process.env.CODEX_HOME || join(process.env.HOME || "/root", ".codex");
const GENERATED_IMAGE_DIR = join(CODEX_HOME, "generated_images");

// Canonical source-of-truth for generated images: the repo's public/
// dir (gitignored, so `git reset --hard` won't wipe it). The deploy
// script's `cp -r public .next/standalone/public` will replicate this
// into the standalone serving dir on every deploy.
const PUBLIC_GENERATED =
  process.env.SPECTRE_GENERATED_DIR ||
  `${process.cwd()}/public/generated`;

// Mirror destination: Next.js standalone's public dir. The running
// server only reads from here, so we ALSO copy each new image here
// so it's visible immediately without a deploy. Set
// SPECTRE_STANDALONE_GENERATED_DIR="" to disable the mirror (dev box
// where you don't have a standalone build).
const STANDALONE_GENERATED =
  process.env.SPECTRE_STANDALONE_GENERATED_DIR === undefined
    ? `${process.cwd()}/.next/standalone/public/generated`
    : process.env.SPECTRE_STANDALONE_GENERATED_DIR;

const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DEFAULT_EXT = ".png";

function parseCodexJsonl(stdout) {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (
        evt.type === "item.completed" &&
        evt.item?.type === "agent_message" &&
        evt.item.text
      ) {
        text += evt.item.text;
      }
      if (evt.type === "turn.completed" && evt.usage) {
        inputTokens = evt.usage.input_tokens ?? 0;
        outputTokens = evt.usage.output_tokens ?? 0;
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  return { text: text.trim(), inputTokens, outputTokens };
}

/** Spawn `codex exec` and collect stdout/stderr. Never rejects. */
function spawnCodex(args, signal) {
  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, args, {
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    }, TIMEOUT_MS);

    const onAbort = () => {
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    proc.stderr.on("data", (d) => (stderr += d.toString("utf-8")));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr: stderr.slice(-1000),
        exitCode: typeof code === "number" ? code : -1,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: err.message, exitCode: -1, timedOut: false });
    });
  });
}

/** List a directory as a Set, returning empty Set if dir doesn't exist. */
async function listDir(dir) {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

async function findImageFiles(root, depth = 0) {
  if (depth > 4) return [];
  let info;
  try {
    info = await stat(root);
  } catch {
    return [];
  }

  if (info.isFile()) {
    const ext = extname(root).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return [{ path: root, mtimeMs: info.mtimeMs, ext }];
    const detectedExt = await detectImageExt(root);
    return detectedExt ? [{ path: root, mtimeMs: info.mtimeMs, ext: detectedExt }] : [];
  }

  if (!info.isDirectory()) return [];

  const entries = await readdir(root);
  const nested = await Promise.all(
    entries.map((entry) => findImageFiles(join(root, entry), depth + 1))
  );
  return nested.flat();
}

async function detectImageExt(path) {
  try {
    const buf = await readFile(path);
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return ".png";
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return ".jpg";
    }
    if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      return ".webp";
    }
    if (buf.length >= 6) {
      const sig = buf.subarray(0, 6).toString("ascii");
      if (sig === "GIF87a" || sig === "GIF89a") return ".gif";
    }
  } catch {
    // unreadable or too large for the current filesystem state
  }
  return null;
}

export async function resolveGeneratedImageForTest(generatedImageDir, newEntries, sinceMs = 0) {
  const candidates = [];
  const roots = newEntries.length > 0 ? newEntries : await readdir(generatedImageDir).catch(() => []);
  for (const entry of roots) {
    for (const candidate of await findImageFiles(join(generatedImageDir, entry))) {
      if (candidate.mtimeMs >= sinceMs - 1000) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

async function resolveGeneratedImage(newEntries, sinceMs) {
  return resolveGeneratedImageForTest(GENERATED_IMAGE_DIR, newEntries, sinceMs);
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerOpenAITools(server) {
  server.registerTool(
    "openai.image",
    {
      description:
        "Generate an image via OpenAI's built-in image_gen capability through Codex CLI " +
        "(ChatGPT Plus subscription — no API key needed). " +
        "Returns a /generated/<uuid>.png URL that Spectre serves statically. " +
        "Use when the user asks for illustrations, diagrams, UI mockups, or any visual output.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .describe("Detailed description of the image to generate"),
      },
    },
    async ({ prompt }, extra) => {
      try {
        await mkdir(PUBLIC_GENERATED, { recursive: true });

        // Snapshot before generation so we can detect newly created files.
        // Also keep a timestamp fallback: some Codex versions create a
        // top-level generation folder before the final image lands inside it.
        const startedAt = Date.now();
        const before = await listDir(GENERATED_IMAGE_DIR);

        const args = [
          "exec",
          "--full-auto",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          `Generate an image: ${prompt}`,
        ];

        const { stdout, stderr, exitCode, timedOut } = await spawnCodex(
          args,
          extra?.signal
        );

        if (timedOut) {
          return errResult(`openai.image timed out after ${TIMEOUT_MS / 1000}s`);
        }

        const { text } = parseCodexJsonl(stdout);

        // Find what Codex's image_gen tool created in its output dir.
        // Newer Codex versions may create a directory per generation, with
        // the image nested inside. Older versions wrote a flat image file.
        const after = await listDir(GENERATED_IMAGE_DIR);
        const newEntries = [...after].filter((f) => !before.has(f));
        const image = await resolveGeneratedImage(newEntries, startedAt);

        if (!image) {
          const errDetail =
            exitCode !== 0
              ? `codex exited ${exitCode}: ${stderr}`
              : newEntries.length > 0
                ? `image generation created ${newEntries.length} new entr${newEntries.length === 1 ? "y" : "ies"}, but no supported image file was found inside`
                : "image generation completed but no file was saved to disk";
          return errResult(`openai.image failed: ${errDetail}\n\nCodex output:\n${text || "(none)"}`);
        }

        const ext = image.ext || extname(image.path) || DEFAULT_EXT;
        const id = randomUUID();
        const destName = `${id}${ext}`;
        // Canonical write — survives the next deploy.
        await mkdir(PUBLIC_GENERATED, { recursive: true });
        await copyFile(image.path, join(PUBLIC_GENERATED, destName));
        // Mirror into the live standalone serving dir so the file is
        // reachable at /generated/<name> immediately, without a redeploy.
        // Best-effort — a failure here doesn't break the canonical save.
        if (STANDALONE_GENERATED) {
          try {
            await mkdir(STANDALONE_GENERATED, { recursive: true });
            await copyFile(image.path, join(STANDALONE_GENERATED, destName));
          } catch (mirrorErr) {
            // Standalone may not exist yet on a fresh dev box. Carry on.
            console.warn(`[openai.image] mirror to standalone failed: ${mirrorErr.message}`);
          }
        }

        const url = `/generated/${destName}`;
        // Terse, single-line tool result. Earlier we echoed `text`
        // (codex's narrative) here too — and codex tends to repeat the
        // file path in that narrative, so Claude saw the URL multiple
        // times in the tool_result and ended up rendering the image 2-3
        // times in the chat reply. Keep it to one line: the URL + a
        // single embed instruction. Claude's final markdown ![]() is
        // the ONLY place the image should render.
        return {
          content: [
            {
              type: "text",
              text:
                `Saved at ${url}. Embed this in your reply EXACTLY ONCE as ` +
                `\`![short alt](${url})\`. Do not paste the URL or filename ` +
                `anywhere else in the reply.`,
            },
          ],
        };
      } catch (err) {
        return errResult(`openai.image failed: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "openai.chat",
    {
      description:
        "Run a task through a GPT model via Codex CLI (ChatGPT Plus subscription — no API key needed). " +
        "Use as a second-opinion subagent or when GPT-specific capabilities help: " +
        "gpt-5.5 for smart general tasks, gpt-5.3-codex for coding-focused tasks, " +
        "gpt-5.4-mini for fast responses. " +
        "Pure inference — no file I/O, no approval gate.",
      inputSchema: {
        task: z.string().min(1).describe("The task or question for GPT"),
        context: z
          .string()
          .optional()
          .describe(
            "Extra context to prepend (file contents, prior snippets, reference data). " +
              "Prepended as [Context]\\n\\n<context>\\n\\n[Task]\\n\\n<task>."
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Codex model ID (default: gpt-5.5). Options: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2. " +
              "Pass the exact model ID string."
          ),
        system: z
          .string()
          .optional()
          .describe("Custom system prompt preamble (prepended to the prompt)"),
      },
    },
    async ({ task, context, model, system }, extra) => {
      try {
        const parts = [];
        if (system) parts.push(`[Instructions]\n${system}`);
        if (context) parts.push(`[Context]\n\n${context}`);
        parts.push(`[Task]\n\n${task}`);
        const prompt = parts.join("\n\n");

        const args = [
          "exec",
          "--full-auto",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
        ];
        if (model) args.push("-m", model);
        args.push(prompt);

        const { stdout, stderr, exitCode, timedOut } = await spawnCodex(
          args,
          extra?.signal
        );

        if (timedOut) {
          return errResult(`openai.chat timed out after ${TIMEOUT_MS / 1000}s`);
        }

        const { text, inputTokens, outputTokens } = parseCodexJsonl(stdout);

        if (exitCode !== 0 && !text) {
          return errResult(`openai.chat failed (exit ${exitCode}): ${stderr}`);
        }

        return {
          content: [{ type: "text", text: text || "(no output)" }],
          structuredContent: {
            output: text,
            model: model || "gpt-5.5",
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
        };
      } catch (err) {
        return errResult(`openai.chat failed: ${err.message}`);
      }
    }
  );
}
