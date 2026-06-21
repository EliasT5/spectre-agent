import path from "node:path";
import fs from "node:fs/promises";

export const PDF_ROOT: string = process.env.PDF_ROOT ?? path.join(process.cwd(), ".jerome-pdfs");

if (!path.isAbsolute(PDF_ROOT)) {
  throw new Error(`PDF_ROOT must be absolute, got: ${PDF_ROOT}`);
}

const PDF_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PdfPathError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PdfPathError";
  }
}

export function pdfFilePath(id: string): string {
  if (!PDF_ID_RE.test(id)) throw new PdfPathError("Invalid pdf id");
  return path.join(PDF_ROOT, `${id}.pdf`);
}

export async function verifyPdfPath(absPath: string): Promise<string> {
  const rootPrefix = PDF_ROOT.endsWith(path.sep) ? PDF_ROOT : PDF_ROOT + path.sep;
  if (!absPath.startsWith(rootPrefix)) {
    throw new PdfPathError("Path escapes PDF root");
  }
  let real: string;
  try {
    real = await fs.realpath(absPath);
  } catch {
    throw new PdfPathError("PDF file not found");
  }
  if (!real.startsWith(rootPrefix)) {
    throw new PdfPathError("Resolved path escapes PDF root");
  }
  const stat = await fs.lstat(real);
  if (stat.isSymbolicLink()) throw new PdfPathError("Symlink rejected");
  return real;
}
