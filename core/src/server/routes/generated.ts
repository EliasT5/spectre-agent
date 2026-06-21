import { Hono } from "hono";
import { existsSync } from "fs";
import { readdir, stat, unlink, mkdir, readFile } from "fs/promises";
import path from "path";
import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne } from "@/lib/ai/embeddings";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const STANDALONE_GENERATED_DIR =
  process.env.SPECTRE_STANDALONE_DIR || path.join(process.cwd(), ".next/standalone/public/generated");
const GENERATED_DIR =
  process.env.SPECTRE_GENERATED_DIR ||
  (existsSync(STANDALONE_GENERATED_DIR)
    ? STANDALONE_GENERATED_DIR
    : path.join(process.cwd(), "public", "generated"));

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

async function ensureDir() {
  await mkdir(GENERATED_DIR, { recursive: true });
}

export const generated = new Hono();

generated.get("/", async (c) => {
  try {
    await ensureDir();
    const names = await readdir(GENERATED_DIR);
    const imageNames = names.filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()));

    const files = await Promise.all(
      imageNames.map(async (name) => {
        const s = await stat(path.join(GENERATED_DIR, name));
        return { name, url: `/generated/${name}`, createdAt: s.birthtime.toISOString(), size: s.size };
      }),
    );

    // Newest first
    files.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ files });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: msg }, 500);
  }
});

// Byte-serving for /generated/<name> (mounted at the TOP level in main.ts, NOT
// under /api → not behind coreAuth; it's image bytes the chat embeds and the
// channel/Telegram delivery fetches). The legacy Next route used to serve these;
// the bun core never had it, so generated images (openai.image, screenshots)
// didn't resolve in the binary. Path-traversal-safe: name is a single segment.
export const generatedFiles = new Hono();

generatedFiles.get("/:name", async (c) => {
  const name = c.req.param("name");
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return c.text("invalid name", 400);
  }
  const mime = MIME[path.extname(name).toLowerCase()];
  if (!mime) return c.text("unsupported type", 400);
  const full = path.join(GENERATED_DIR, name);
  if (!existsSync(full)) return c.text("not found", 404);
  const buf = await readFile(full);
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
  });
});

// ── Recall layer ─────────────────────────────────────────────────────
// The byte rail above serves/lists raw files. These two endpoints add the
// INDEX: a row per image with a caption embedding so (a) the agent can
// resurface a past image by description (media.search broker tool) and (b) the
// Memory tab can browse captioned media. Image bytes stay on disk; only metadata
// + the embedding live in generated_media.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MediaRow {
  id: string;
  name: string;
  url: string;
  kind: string;
  caption: string | null;
  created_at: string;
  similarity?: number;
}

function toItem(r: MediaRow) {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    kind: r.kind,
    caption: r.caption,
    createdAt: r.created_at,
    ...(typeof r.similarity === "number" ? { similarity: r.similarity } : {}),
  };
}

// POST /api/generated/record — index a generated image (called by the screenshot
// tool right after it writes the file; image-gen can call it too). Embeds the
// caption best-effort (no embedding -> still browsable, just not semantically
// recallable). Idempotent on `name` (a retry updates the row).
generated.post("/record", async (c) => {
  let body: { name?: unknown; url?: unknown; kind?: unknown; caption?: unknown; threadId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const name = String(body?.name ?? "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return c.json({ error: "invalid name" }, 400);
  }
  if (!IMAGE_EXTS.has(path.extname(name).toLowerCase())) {
    return c.json({ error: "not an image file" }, 400);
  }
  const url = String(body?.url ?? `/generated/${name}`);
  const kind = body?.kind === "image" ? "image" : "screenshot";
  const caption = body?.caption ? String(body.caption).slice(0, 2000) : null;
  const threadId =
    typeof body?.threadId === "string" && UUID_RE.test(body.threadId) ? body.threadId : null;

  let embedding: number[] | null = null;
  if (caption) {
    try {
      embedding = await embedOne(caption);
    } catch (err) {
      console.error(`[media] record embed failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const row: Record<string, unknown> = {
    name,
    url,
    kind,
    caption,
    ...(threadId ? { thread_id: threadId } : {}),
    ...(embedding ? { embedding } : {}),
  };

  try {
    const supabase = createServiceSupabase();
    let { data, error } = await supabase
      .from("generated_media")
      .upsert(row, { onConflict: "name" })
      .select("id")
      .single();
    // A thread_id that points at a non-existent thread would fail the FK — record
    // the image anyway (the thread link is a nice-to-have, the image is the point).
    if (error && row.thread_id && /foreign key|violates|constraint/i.test(error.message)) {
      delete row.thread_id;
      ({ data, error } = await supabase
        .from("generated_media")
        .upsert(row, { onConflict: "name" })
        .select("id")
        .single());
    }
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ ok: true, id: data?.id, embedded: !!embedding });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: msg }, 500);
  }
});

// GET /api/generated/library?q=&limit= — the recall-indexed view. With `q`,
// semantic search over captions (match_generated_media); without, newest first.
// Falls back to recent rows if embedding/RPC is unavailable so the UI never 500s
// just because the embedder is down.
generated.get("/library", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 24));
  try {
    const supabase = createServiceSupabase();

    if (q) {
      let vec: number[] | null = null;
      try {
        vec = await embedOne(q);
      } catch (err) {
        console.error(`[media] query embed failed: ${err instanceof Error ? err.message : err}`);
      }
      if (vec) {
        const { data, error } = await supabase.rpc("match_generated_media", {
          query_embedding: vec,
          match_count: limit,
        });
        if (!error && Array.isArray(data)) {
          return c.json({ items: (data as MediaRow[]).map(toItem), query: q });
        }
      }
      // fall through to recent on embed/RPC failure
    }

    const { data, error } = await supabase
      .from("generated_media")
      .select("id,name,url,kind,caption,created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return c.json({ error: error.message }, 500);
    return c.json({ items: (data as MediaRow[]).map(toItem) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: msg }, 500);
  }
});

generated.delete("/", async (c) => {
  const name = c.req.query("name");
  if (!name || name.includes("/") || name.includes("..")) {
    return c.json({ error: "invalid name" }, 400);
  }
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    return c.json({ error: "not an image file" }, 400);
  }
  try {
    await unlink(path.join(GENERATED_DIR, name));
    // Also drop the recall-index row (best-effort; the file is the source of truth).
    try {
      await createServiceSupabase().from("generated_media").delete().eq("name", name);
    } catch (err) {
      console.error(`[media] index cleanup failed: ${err instanceof Error ? err.message : err}`);
    }
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return c.json({ error: msg }, 500);
  }
});
