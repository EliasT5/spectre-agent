/**
 * Page-aware token chunker for PDF intake.
 *
 * - Approximates tokens as chars/4 (accurate enough for OpenAI's
 *   8191-token embedding limit; we target 600 tokens ≈ 2400 chars).
 * - Streams chunks via a generator so a 50 MB PDF doesn't blow the heap.
 * - Each chunk records the page range it came from so RAG hits can cite
 *   pages back to the user.
 * - Hard-caps at MAX_CHUNKS to refuse pathological scanned books that
 *   extracted as one giant text blob.
 */

const TARGET_CHARS = 2400;
const OVERLAP_CHARS = 320;
const MIN_CHUNK_CHARS = 80;

export const MAX_CHUNKS_PER_DOC = 2000;

export interface PdfChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  text: string;
  tokenCount: number;
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function* chunkPages(pages: string[]): Generator<PdfChunk> {
  let buf = "";
  let bufStart = 1;
  let bufEnd = 1;
  let idx = 0;

  function* flush(): Generator<PdfChunk> {
    if (buf.length < MIN_CHUNK_CHARS) return;
    yield {
      index: idx++,
      pageStart: bufStart,
      pageEnd: bufEnd,
      text: buf,
      tokenCount: approxTokens(buf),
    };
    if (buf.length > OVERLAP_CHARS) {
      buf = buf.slice(-OVERLAP_CHARS);
      bufStart = bufEnd;
    } else {
      buf = "";
    }
  }

  for (let p = 0; p < pages.length; p++) {
    const pageNum = p + 1;
    const pageText = (pages[p] ?? "").trim();
    if (!pageText) continue;

    if (!buf) bufStart = pageNum;
    bufEnd = pageNum;

    if (buf.length + pageText.length + 2 <= TARGET_CHARS) {
      buf += (buf ? "\n\n" : "") + pageText;
      continue;
    }

    if (buf) {
      yield* flush();
      if (idx >= MAX_CHUNKS_PER_DOC) return;
      bufStart = pageNum;
      bufEnd = pageNum;
    }

    let cursor = 0;
    while (cursor < pageText.length) {
      const slice = pageText.slice(cursor, cursor + TARGET_CHARS);
      buf = (buf ? buf + "\n" : "") + slice;
      cursor += TARGET_CHARS;
      if (buf.length >= TARGET_CHARS) {
        yield* flush();
        if (idx >= MAX_CHUNKS_PER_DOC) return;
        bufStart = pageNum;
        bufEnd = pageNum;
      }
    }
  }

  if (buf) {
    yield {
      index: idx++,
      pageStart: bufStart,
      pageEnd: bufEnd,
      text: buf,
      tokenCount: approxTokens(buf),
    };
  }
}
