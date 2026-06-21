"use client";

import type * as PdfjsType from "pdfjs-dist";

let configured = false;
let cached: typeof PdfjsType | null = null;

/**
 * Lazy-load pdfjs-dist at runtime in the browser only.
 *
 * Importing it at module top would pull DOMMatrix / Path2D references
 * into Next's server bundle, which breaks SSG prerender of any page
 * whose client component graph reaches the reader. The dynamic import
 * keeps the dep out of the server graph entirely.
 *
 * The worker URL uses webpack's `new URL(..., import.meta.url)` asset
 * pattern, which Next 16's webpack pipeline emits as a hashed asset.
 */
export async function getPdfjs(): Promise<typeof PdfjsType> {
  if (!cached) {
    cached = await import("pdfjs-dist");
  }
  if (!configured) {
    cached.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    configured = true;
  }
  return cached;
}
