import { createServiceSupabase } from "@/lib/supabase/server";
import { embedOne } from "@/lib/ai/embeddings";

export interface PdfChunkHit {
  id: string;
  doc_id: string;
  page_start: number;
  page_end: number;
  text: string;
  similarity: number;
}

export interface PdfDocSummary {
  id: string;
  title: string | null;
  filename: string;
  summary: string | null;
}

const TOP_K = 8;

export async function retrievePdfContext(
  query: string,
  pdfIds: string[],
): Promise<{ docs: PdfDocSummary[]; hits: PdfChunkHit[] }> {
  if (!query.trim() || pdfIds.length === 0) {
    return { docs: [], hits: [] };
  }
  const supabase = createServiceSupabase();

  const [{ data: docs }, embedding] = await Promise.all([
    supabase
      .from("pdf_documents")
      .select("id, title, filename, summary")
      .in("id", pdfIds),
    embedOne(query),
  ]);

  const { data: hits } = await supabase.rpc("match_pdf_chunks", {
    query_embedding: embedding,
    doc_ids: pdfIds,
    match_count: TOP_K,
  });

  return {
    docs: (docs ?? []) as PdfDocSummary[],
    hits: (hits ?? []) as PdfChunkHit[],
  };
}

export function buildPdfContextHeader(
  docs: PdfDocSummary[],
  hits: PdfChunkHit[],
): string {
  if (docs.length === 0) return "";

  const docMap = new Map(docs.map((d) => [d.id, d]));
  const docList = docs
    .map((d) => `  - "${d.title ?? d.filename}" (id: ${d.id.slice(0, 8)})`)
    .join("\n");

  const hitsBlock =
    hits.length === 0
      ? "(no relevant passages retrieved for this question)"
      : hits
          .map((h, i) => {
            const doc = docMap.get(h.doc_id);
            const docName = doc?.title ?? doc?.filename ?? h.doc_id.slice(0, 8);
            const pageRange =
              h.page_start === h.page_end
                ? `p.${h.page_start}`
                : `p.${h.page_start}-${h.page_end}`;
            return `[#${i + 1}  "${docName}"  ${pageRange}]\n${h.text.trim()}`;
          })
          .join("\n\n");

  return `\n\n## Reading session\nThe user is reading these PDFs and chatting about them:\n${docList}\n\nRelevant passages retrieved by similarity search for the user's latest question:\n\n${hitsBlock}\n\nWhen citing, reference the document title and page number. If the passages don't answer the question, say so plainly rather than guessing.\n`;
}
