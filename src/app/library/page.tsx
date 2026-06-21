"use client";

import "./library.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { TabShell, Panel, Skeleton, Button, Chip } from "@/components/ui";
import { Image as ImageIcon, FileText, Trash2, RefreshCw, X, Upload, RotateCw } from "lucide-react";

/**
 * Library — Spectre's stuff: PDFs you chat about (RAG) + the media gallery
 * (screenshots + generated images). PDFs upload to /api/pdfs, get chunked +
 * embedded by intake, then you attach them to a chat thread to ground answers.
 * Media comes from the /generated rail (and arrives as photos on Telegram /
 * WhatsApp / Discord). Built on the kit + the existing core endpoints.
 */

interface GenFile {
  name: string;
  url: string;
  createdAt: string;
  size: number;
}

interface PdfDoc {
  id: string;
  filename: string;
  title: string | null;
  summary: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  file_size: number | null;
  page_count: number | null;
  error: string | null;
  uploaded_at: string;
}

const STATUS_TONE: Record<PdfDoc["status"], string> = {
  ready: "var(--color-success)",
  failed: "var(--color-error)",
  processing: "var(--accent-bright)",
  pending: "var(--color-text-muted)",
};

export default function LibraryTab() {
  const [files, setFiles] = useState<GenFile[] | null>(null);
  const [docs, setDocs] = useState<PdfDoc[] | null>(null);
  const [sel, setSel] = useState<GenFile | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadMedia = useCallback(async () => {
    try {
      const r = await fetch("/api/generated");
      const d = await r.json();
      setFiles(Array.isArray(d.files) ? d.files : []);
    } catch {
      setFiles([]);
    }
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const r = await fetch("/api/pdfs");
      const d = await r.json();
      setDocs(Array.isArray(d) ? d : (d.documents ?? []));
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void loadMedia();
    void loadDocs();
  }, [loadMedia, loadDocs]);

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(list)) fd.append("file", f);
      await fetch("/api/pdfs/upload", { method: "POST", body: fd }).catch(() => {});
      await loadDocs(); // show them as pending
      // Kick ingest (chunk + embed). Synchronous on the core; refresh when done.
      await fetch("/api/pdfs/intake", { method: "POST" }).catch(() => {});
      await loadDocs();
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function reprocess(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/pdfs/${id}/reprocess`, { method: "POST" }).catch(() => {});
      await fetch("/api/pdfs/intake", { method: "POST" }).catch(() => {});
      await loadDocs();
    } finally {
      setBusy(false);
    }
  }

  async function delDoc(id: string) {
    setDocs((p) => (p ?? []).filter((d) => d.id !== id));
    await fetch(`/api/pdfs/${id}`, { method: "DELETE" }).catch(() => {});
  }

  async function delMedia(name: string) {
    setFiles((p) => (p ?? []).filter((f) => f.name !== name));
    if (sel?.name === name) setSel(null);
    await fetch(`/api/generated/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
  }

  const docCount = docs?.length ?? 0;
  const mediaCount = files?.length ?? 0;

  return (
    <TabShell title="Library" eyebrow="MEDIA · LIBRARY" status={`${docCount} docs · ${mediaCount} media`}>
      {/* ── Documents (PDF RAG) ── */}
      <Panel
        label="READING"
        title="Documents you chat about"
        icon={<FileText size={16} />}
        aside={
          <div className="lib-panel-aside">
            <Button variant="ghost" onClick={() => void loadDocs()}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <Button onClick={() => fileInput.current?.click()} disabled={busy}>
              <Upload size={14} /> {busy ? "Working…" : "Upload PDF"}
            </Button>
          </div>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          aria-label="Upload PDFs"
          onChange={(e) => void upload(e.target.files)}
        />
        {docs === null ? (
          <Skeleton height={120} />
        ) : docs.length === 0 ? (
          <div className="lib-empty">
            <div className="lib-empty-orb">
              <FileText size={22} />
            </div>
            <p className="lib-empty-text">
              No documents yet. Upload a PDF — Spectre extracts + embeds it, then you can attach it to a chat
              (the paperclip in chat) so answers are grounded in the document with page citations.
            </p>
          </div>
        ) : (
          <div className="lib-doc-list">
            {docs.map((d) => (
              <div key={d.id} className="lib-doc-row">
                <FileText size={18} className="lib-doc-icon" />
                <div className="lib-doc-body">
                  <div className="lib-doc-name">
                    {d.title?.trim() || d.filename}
                  </div>
                  <div className="lib-doc-meta">
                    {d.page_count ? `${d.page_count}p · ` : ""}
                    {d.file_size ? `${Math.round(d.file_size / 1024)}kb · ` : ""}
                    {new Date(d.uploaded_at).toLocaleDateString()}
                    {d.status === "failed" && d.error ? ` · ${d.error.slice(0, 60)}` : ""}
                  </div>
                </div>
                <Chip color={STATUS_TONE[d.status]}>{d.status}</Chip>
                {d.status === "failed" && (
                  <button
                    onClick={() => void reprocess(d.id)}
                    title="Reprocess"
                    className="lib-icon-btn"
                  >
                    <RotateCw size={14} />
                  </button>
                )}
                <button
                  onClick={() => void delDoc(d.id)}
                  title="Delete"
                  className="lib-icon-btn danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* ── Media gallery ── */}
      <Panel
        label="MEDIA"
        title="Screenshots & generated images"
        icon={<ImageIcon size={16} />}
        aside={
          <Button variant="ghost" onClick={() => void loadMedia()}>
            <RefreshCw size={14} /> Refresh
          </Button>
        }
      >
        {files === null ? (
          <Skeleton height={220} />
        ) : files.length === 0 ? (
          <div className="lib-empty">
            <div className="lib-empty-orb">
              <ImageIcon size={22} />
            </div>
            <p className="lib-empty-text">
              No images yet. Ask Spectre to take a screenshot or generate an image — they collect here, and on
              Telegram / WhatsApp / Discord they arrive as photos.
            </p>
          </div>
        ) : (
          <div className="lib-media-grid">
            {files.map((f) => (
              <div key={f.name} className="lib-media-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.url}
                  alt={f.name}
                  loading="lazy"
                  onClick={() => setSel(f)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(f); } }}
                  role="button"
                  tabIndex={0}
                  className="lib-media-img"
                />
                <div className="lib-media-footer">
                  <span className="lib-media-caption">
                    {new Date(f.createdAt).toLocaleDateString()} · {Math.round(f.size / 1024)}kb
                  </span>
                  <button
                    onClick={() => void delMedia(f.name)}
                    title="Delete"
                    className="lib-media-delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {sel && (
        <div
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setSel(null)}
          onKeyDown={(e) => e.key === "Escape" && setSel(null)}
          className="lib-lightbox"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sel.url} alt={sel.name} className="lib-lightbox-img" />
          <button
            onClick={() => setSel(null)}
            title="Close"
            className="lib-lightbox-close"
          >
            <X size={22} />
          </button>
        </div>
      )}
    </TabShell>
  );
}
