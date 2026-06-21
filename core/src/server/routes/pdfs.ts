import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { runPdfIntake } from "@/lib/ai/pdf-intake";
import { pdfFilePath, PDF_ROOT, PdfPathError, verifyPdfPath } from "@/lib/library/path-guard";
import { createServiceSupabase } from "@/lib/supabase/server";

export const pdfs = new Hono();

const MAX_BYTES = 50 * 1024 * 1024;

pdfs.get("/", async (c) => {
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("pdf_documents")
    .select("id, filename, title, summary, category, tags, status, file_size, page_count, error, uploaded_at, processed_at")
    .order("uploaded_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data ?? []);
});

pdfs.post("/intake", async (c) => {
  const result = await runPdfIntake();
  return c.json(result);
});

pdfs.post("/upload", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  const files = form.getAll("file").filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return c.json({ error: "no files" }, 400);
  }

  const supabase = createServiceSupabase();
  const created: { id: string; filename: string; status: string }[] = [];
  const rejected: { filename: string; error: string }[] = [];

  // Ensure the storage root exists — on a fresh install (or a new data volume)
  // the dir is absent, and writeFile would ENOENT every upload.
  await mkdir(PDF_ROOT, { recursive: true });

  for (const file of files) {
    try {
      if (file.size > MAX_BYTES) {
        rejected.push({ filename: file.name, error: `too large (${file.size} > ${MAX_BYTES} bytes)` });
        continue;
      }
      const lower = (file.name || "").toLowerCase();
      const looksPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
      if (!looksPdf) {
        rejected.push({ filename: file.name, error: "not a pdf" });
        continue;
      }

      const id = randomUUID();
      const path = pdfFilePath(id);
      const bytes = Buffer.from(await file.arrayBuffer());

      if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        rejected.push({ filename: file.name, error: "not a valid PDF (missing %PDF- header)" });
        continue;
      }

      await writeFile(path, bytes, { mode: 0o640 });

      const { data, error } = await supabase
        .from("pdf_documents")
        .insert({
          // Persist the SAME id the file path was derived from — otherwise the DB
          // default (gen_random_uuid) gives the row a different id than its file,
          // and intake's path-guard rejects every doc with "file_path mismatch".
          id,
          filename: file.name || "untitled.pdf",
          file_path: path,
          file_size: bytes.length,
          status: "pending",
        })
        .select("id, filename, status")
        .single();

      if (error || !data) {
        rejected.push({ filename: file.name, error: error?.message ?? "db insert failed" });
        continue;
      }

      created.push(data as { id: string; filename: string; status: string });
    } catch (err) {
      rejected.push({ filename: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return c.json({ created, rejected, root: PDF_ROOT }, 201);
});

pdfs.get("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("pdf_documents")
    .select("id, filename, title, summary, category, tags, status, file_size, page_count, error, uploaded_at, processed_at")
    .eq("id", id)
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "not found" }, 404);
  return c.json(data);
});

pdfs.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();

  try {
    const path = pdfFilePath(id);
    await unlink(path).catch(() => undefined);
  } catch (err) {
    if (!(err instanceof PdfPathError)) throw err;
  }

  const { error } = await supabase.from("pdf_documents").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

pdfs.get("/:id/file", async (c) => {
  // No per-route auth: the shell proxy strips cookies, so a cookie gate here can
  // never pass. The global CORE_TOKEN middleware already gates every /api/* hit,
  // and the browser-facing PIN is enforced at the shell edge.
  const id = c.req.param("id");

  let path: string;
  try {
    path = pdfFilePath(id);
  } catch (err) {
    return c.json({ error: err instanceof PdfPathError ? err.message : "bad id" }, 400);
  }

  const supabase = createServiceSupabase();
  const { data: row } = await supabase
    .from("pdf_documents")
    .select("id, filename")
    .eq("id", id)
    .single();
  if (!row) return c.json({ error: "not found" }, 404);

  let real: string;
  try {
    real = await verifyPdfPath(path);
  } catch (err) {
    if (err instanceof PdfPathError) return c.json({ error: err.message }, 404);
    throw err;
  }

  const buffer = await readFile(real);
  const filename = (row.filename as string) || `${id}.pdf`;
  const safeName = filename.replace(/"/g, "");

  return c.body(buffer, 200, {
    "Content-Type": "application/pdf",
    "Content-Length": String(buffer.byteLength),
    "Content-Disposition": `inline; filename="${safeName}"`,
    "Cache-Control": "private, max-age=3600",
  });
});

pdfs.post("/:id/reprocess", async (c) => {
  const id = c.req.param("id");
  const supabase = createServiceSupabase();

  const { error: chunkErr } = await supabase.from("pdf_chunks").delete().eq("doc_id", id);
  if (chunkErr) return c.json({ error: chunkErr.message }, 500);

  const { error: docErr } = await supabase
    .from("pdf_documents")
    .update({ status: "pending", error: null, processed_at: null })
    .eq("id", id);
  if (docErr) return c.json({ error: docErr.message }, 500);

  return c.json({ ok: true });
});
