/**
 * PDF intake — runs as part of the nightly Dream pass.
 *
 * For each pdf_documents row with status='pending':
 *   1. Lock atomically (pending → processing).
 *   2. Read PDF bytes from the configured PDF store (<pdf-dir>/<id>.pdf).
 *   3. Extract page-text via unpdf (pure JS, zero native deps).
 *   4. Stream chunks through the chunker → embed in batches → insert.
 *   5. Generate clean title + 1-paragraph summary + category + tags
 *      with Haiku, update the document row.
 *   6. Extract 5–15 atomic key facts → embed → insert into `memory`
 *      with category='pdf' so Jerome "remembers" the book.
 *   7. Mark status='ready' (or 'failed' with error on any throw).
 *
 * Bounded: at most MAX_PER_RUN docs per nightly invocation so a
 * 30-PDF backlog doesn't blow the dream window.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { extractText } from "unpdf";
import { createServiceSupabase } from "@/lib/supabase/server";
import { pdfFilePath, verifyPdfPath } from "@/lib/library/path-guard";
import { chunkPages } from "@/lib/library/chunker";
import { embedBatch } from "@/lib/ai/embeddings";

const MAX_PER_RUN = 5;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MEMORY_CATEGORY = "pdf";
const MEMORY_IMPORTANCE = 6;

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

export interface IntakeRunResult {
  scanned: number;
  processed: number;
  failed: number;
  errors: { id: string; error: string }[];
}

export async function runPdfIntake(): Promise<IntakeRunResult> {
  const supabase = createServiceSupabase();
  const result: IntakeRunResult = { scanned: 0, processed: 0, failed: 0, errors: [] };

  const { data: pending } = await supabase
    .from("pdf_documents")
    .select("id, filename, file_path, status")
    .eq("status", "pending")
    .order("uploaded_at", { ascending: true })
    .limit(MAX_PER_RUN);

  const rows = (pending ?? []) as { id: string; filename: string; file_path: string; status: string }[];
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  for (const row of rows) {
    const { data: locked } = await supabase
      .from("pdf_documents")
      .update({ status: "processing", error: null })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id, filename, file_path")
      .single();

    if (!locked) continue;

    try {
      await processOne(supabase, locked.id, locked.filename, locked.file_path);
      await supabase
        .from("pdf_documents")
        .update({ status: "ready", processed_at: new Date().toISOString(), error: null })
        .eq("id", locked.id);
      result.processed += 1;
      console.log(`[pdf-intake] ready id=${locked.id} filename=${locked.filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from("pdf_documents")
        .update({ status: "failed", error: message.slice(0, 1000) })
        .eq("id", locked.id);
      result.failed += 1;
      result.errors.push({ id: locked.id, error: message });
      console.error(`[pdf-intake] failed id=${locked.id}: ${message}`);
    }
  }

  return result;
}

type SupabaseLike = ReturnType<typeof createServiceSupabase>;

async function processOne(
  supabase: SupabaseLike,
  id: string,
  filename: string,
  filePath: string,
): Promise<void> {
  console.log(`[pdf-intake] start id=${id} filename=${filename}`);

  // 1. Read + extract.
  const expected = pdfFilePath(id);
  if (filePath !== expected) {
    throw new Error(`file_path mismatch (expected ${expected}, got ${filePath})`);
  }
  const real = await verifyPdfPath(filePath);
  const buf = await readFile(real);
  console.log(`[pdf-intake] extract id=${id} bytes=${buf.length}`);

  // unpdf wants a Uint8Array view of the buffer; pass the underlying
  // ArrayBuffer slice to avoid a redundant copy.
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const { totalPages, text: pages } = await extractText(view, { mergePages: false });
  const pageList = Array.isArray(pages) ? pages : [pages];

  await supabase.from("pdf_documents").update({ page_count: totalPages }).eq("id", id);

  // 2. Chunk + embed + insert.
  const chunkBuf: { idx: number; pageStart: number; pageEnd: number; text: string; tokens: number }[] = [];
  for (const c of chunkPages(pageList)) {
    chunkBuf.push({
      idx: c.index,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      text: c.text,
      tokens: c.tokenCount,
    });
  }
  console.log(`[pdf-intake] chunked id=${id} chunks=${chunkBuf.length} pages=${totalPages}`);

  if (chunkBuf.length > 0) {
    const embeddings = await embedBatch(chunkBuf.map((c) => c.text));
    if (embeddings.length !== chunkBuf.length) {
      throw new Error(`embedding count mismatch ${embeddings.length} vs ${chunkBuf.length}`);
    }
    const rows = chunkBuf.map((c, i) => ({
      doc_id: id,
      chunk_index: c.idx,
      page_start: c.pageStart,
      page_end: c.pageEnd,
      text: c.text,
      token_count: c.tokens,
      embedding: embeddings[i],
    }));
    // Insert in batches of 100 to stay under request size limits.
    for (let i = 0; i < rows.length; i += 100) {
      const slice = rows.slice(i, i + 100);
      const { error } = await supabase.from("pdf_chunks").insert(slice);
      if (error) throw new Error(`pdf_chunks insert failed: ${error.message}`);
    }
    console.log(`[pdf-intake] embedded id=${id} count=${embeddings.length}`);
  }

  // 3. Title + summary + category + tags via Haiku.
  const head = pageList.slice(0, 4).join("\n\n").slice(0, 12000);
  const meta = await haikuMeta(filename, head);
  await supabase
    .from("pdf_documents")
    .update({
      title: meta.title,
      summary: meta.summary,
      category: meta.category,
      tags: meta.tags,
    })
    .eq("id", id);
  console.log(`[pdf-intake] meta id=${id} title="${meta.title}" category=${meta.category}`);

  // 4. Key facts → memory.
  const allText = pageList.join("\n\n").slice(0, 60000);
  const facts = await haikuFacts(meta.title, allText);
  if (facts.length > 0) {
    const factEmbeds = await embedBatch(facts);
    const memoryRows = facts.map((fact, i) => ({
      content: `[${meta.title}] ${fact}`,
      category: MEMORY_CATEGORY,
      embedding: factEmbeds[i],
      importance: MEMORY_IMPORTANCE,
    }));
    const { error } = await supabase.from("memory").insert(memoryRows);
    if (error) throw new Error(`memory insert failed: ${error.message}`);
    console.log(`[pdf-intake] facts id=${id} count=${facts.length}`);
  }
}

interface MetaResult {
  title: string;
  summary: string;
  category: string;
  tags: string[];
}

async function haikuMeta(filename: string, head: string): Promise<MetaResult> {
  const prompt = `You are a librarian classifying a PDF for a personal knowledge base.

ORIGINAL FILENAME: ${filename}

DOCUMENT CONTENT (first few pages):
"""
${head}
"""

Return STRICT JSON with this shape and no commentary:
{
  "title": "<clean human-readable title, max 80 chars>",
  "summary": "<one paragraph (2-4 sentences) covering what the document is and its main thesis or content>",
  "category": "<one of: research, reference, manual, book, paper, business, personal, legal, news, other>",
  "tags": ["<3-7 lowercase free-form tags>"]
}

JSON:`;

  // Best-effort enrichment: title/summary/tags are a nice-to-have on top of the
  // RAG-critical chunks (already inserted by now). The "local & free" path runs
  // Ollama-only with no Anthropic key, so a missing key / LLM error must NOT fail
  // the whole intake — fall back to a filename-derived title.
  try {
    const res = await getAnthropic().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content[0];
    const raw = block?.type === "text" ? block.text : "";
    return parseMeta(raw, filename);
  } catch (err) {
    console.warn(`[pdf-intake] meta enrichment skipped (no LLM): ${err instanceof Error ? err.message : err}`);
    return parseMeta("", filename);
  }
}

function parseMeta(raw: string, fallbackFilename: string): MetaResult {
  const fallback: MetaResult = {
    title: cleanFilename(fallbackFilename),
    summary: "",
    category: "other",
    tags: [],
  };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return {
      title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 120) : fallback.title,
      summary: typeof obj.summary === "string" ? obj.summary.trim().slice(0, 1200) : "",
      category: typeof obj.category === "string" ? obj.category.trim().toLowerCase().slice(0, 40) : "other",
      tags: Array.isArray(obj.tags)
        ? obj.tags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().toLowerCase().slice(0, 32))
            .filter(Boolean)
            .slice(0, 8)
        : [],
    };
  } catch {
    return fallback;
  }
}

function cleanFilename(name: string): string {
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function haikuFacts(title: string, body: string): Promise<string[]> {
  const prompt = `You are extracting durable, non-obvious facts from a document for a personal long-term memory store.

DOCUMENT TITLE: ${title}

CONTENT:
"""
${body}
"""

Output 5-15 standalone sentences. Each sentence must:
- Capture ONE atomic fact, claim, definition, or framework worth remembering long after the document is closed.
- Be self-contained — readable in isolation, no "the author" / "this paper" / "as mentioned above".
- Avoid generic platitudes. Skip restating the title or summary.

FORMAT: one fact per line, no numbering, no bullet markers, no blank lines, no commentary.`;

  // Best-effort (see haikuMeta): no LLM / no key -> just skip fact extraction.
  try {
    const res = await getAnthropic().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const block = res.content[0];
    const raw = block?.type === "text" ? block.text : "";

    return raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*[-*\d.)]\s*/, "").trim())
      .filter((line) => line.length > 20 && line.length < 400)
      .slice(0, 15);
  } catch (err) {
    console.warn(`[pdf-intake] fact extraction skipped (no LLM): ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

