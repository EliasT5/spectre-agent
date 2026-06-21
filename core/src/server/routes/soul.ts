import { Hono } from "hono";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

function soulDir(): string {
  const root = process.env.SPECTRE_REPO_PATH || process.cwd();
  return join(root, "soul");
}

const ALLOWED_FILES = ["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "HEARTBEAT.md"];

export const soul = new Hono();

/** GET /api/soul - list all soul files with contents */
soul.get("/", (c) => {
  const dir = soulDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({
      name,
      content: readFileSync(join(dir, name), "utf-8"),
    }));

  return c.json(files);
});

/** PATCH /api/soul - update a soul file */
soul.patch("/", async (c) => {
  const { name, content } = await c.req.json();

  if (!name || typeof content !== "string") {
    return c.json({ error: "name and content required" }, 400);
  }

  if (!ALLOWED_FILES.includes(name)) {
    return c.json({ error: `Invalid file: ${name}` }, 400);
  }

  const filePath = join(soulDir(), name);
  writeFileSync(filePath, content, "utf-8");

  return c.json({ ok: true, name });
});
