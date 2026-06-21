import { Hono } from "hono";
import { spawn } from "child_process";

/**
 * Critic endpoint - asks Haiku whether a pending tool call looks genuinely
 * destructive, so the permission modal can show a prominent warning
 * instead of a bland gray Approve button. Called by PermissionModal on
 * mount. Latency budget: ~2s via Haiku.
 *
 * Inspired by the Claude Code leak's "Critic" pattern (permission
 * classification via side-query rather than a brittle allowlist).
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

function asHaiku(prompt: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CLAUDE_BIN,
      [
        "--print",
        "--model",
        "claude-haiku-4-5",
        "--permission-mode",
        "bypassPermissions",
        prompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`critic timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err || `claude exit ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export const criticize = new Hono();

criticize.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const tool = typeof body.tool === "string" ? body.tool : "";
  const input = body.input ?? {};
  if (!tool) {
    return c.json({ error: "tool required" }, 400);
  }

  const prompt = `You are a security critic. A coding agent wants to execute this tool:

TOOL: ${tool}
INPUT: ${JSON.stringify(input).slice(0, 800)}

Is this destructive or high-risk? Destructive means: deletes files, force-pushes git, rm -rf, chmod 777, drops database tables, overwrites critical files, sends network mutations (email, DMs, API writes), modifies system configs, or anything irreversible.

Respond in ONE line only, exactly this format:
DESTRUCTIVE: yes|no | <one-sentence reason>

Example good responses:
DESTRUCTIVE: yes | rm -rf on a directory is irreversible
DESTRUCTIVE: no | writing to a new temp file is safe`;

  try {
    const raw = await asHaiku(prompt);
    const line = raw.split("\n").find((l) => l.toUpperCase().startsWith("DESTRUCTIVE:")) ?? raw;
    const match = line.match(/DESTRUCTIVE:\s*(yes|no)\s*\|\s*(.*)/i);
    if (!match) {
      return c.json({ destructive: false, reason: "unparseable critic output", raw });
    }
    return c.json({
      destructive: match[1].toLowerCase() === "yes",
      reason: match[2].trim(),
    });
  } catch (err) {
    // On any failure, fail-safe: don't claim "destructive", let the user
    // decide from the plain modal. We just skip the warning badge.
    return c.json({
      destructive: false,
      reason: "critic unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
