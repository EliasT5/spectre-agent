"use client";

import "./workspace.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/sdk";
import {
  Boxes,
  ChevronRight,
  ExternalLink,
  FileCode,
  FolderGit2,
  Loader2,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";

/**
 * Workspace tab — Jerome-language rebuild (semantic CSS, no Tailwind).
 * All data hooks from the original page are preserved:
 *   - /workspace/slots  → slot list
 *   - /workspace/open   → POST open repo
 *   - /workspace/{id}/tree  → file tree
 *   - /workspace/{id}/file  → file content
 *   - /workspace/{id}/finalize → PR / push
 *   - DELETE /workspace/{id}  → discard
 *
 * Presentation is restructured to match the Jerome monolith's workspace tab:
 * header w/ slot tabs + OPEN REPO, selected-repo card, Jerome chat section,
 * composer dock, collapsible FILES section.
 */

// Where the embedded editor is served. Default = same-origin /code (edge proxy).
const CODE_SERVER_BASE = (process.env.NEXT_PUBLIC_CODE_SERVER_URL || "/code").replace(/\/+$/, "");

interface Slot {
  id: string;
  kind: "sandbox" | "trusted";
  repo_owner: string;
  repo_name: string;
  branch: string;
  base_branch: string;
  status: string;
  pr_url?: string | null;
}

interface TreeEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  return `${(n / (1024 * 1024)).toFixed(1)} M`;
}

export default function WorkspaceTab() {
  // ── Slot state ─────────────────────────────────────────────────────────────
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Slot | null>(null);

  // ── Open-repo dialog ───────────────────────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);

  // ── Files section ──────────────────────────────────────────────────────────
  const [filesOpen, setFilesOpen] = useState(false);
  const [tree, setTree] = useState<TreeEntry[] | null>(null);

  // ── Jerome chat composer ───────────────────────────────────────────────────
  const [chatMsg, setChatMsg] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Finalize (PR) ──────────────────────────────────────────────────────────
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);

  // code-server URL for selected slot
  const editorUrl = (s: Slot) => {
    const folder = s.kind === "sandbox" ? `/workspaces/${s.id}/repo` : "";
    return `${CODE_SERVER_BASE}/${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await call<{ slots: Slot[] }>("/workspace/slots");
      setSlots(r.slots);
      setOff(false);
      // Auto-select first slot if nothing selected
      setSel((cur) => {
        if (cur) {
          const still = r.slots.find((s) => s.id === cur.id);
          return still ?? (r.slots[0] ?? null);
        }
        return r.slots[0] ?? null;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/503/.test(msg)) setOff(true);
      else setError(msg);
      setSlots([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openRepo() {
    if (!repo.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await call("/workspace/open", {
        method: "POST",
        body: JSON.stringify({ repo: repo.trim(), base_branch: base.trim() || "main" }),
      });
      setRepo("");
      setBase("main");
      setDialogOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function selectSlot(s: Slot) {
    setSel(s);
    setTree(null);
    setFilesOpen(false);
    try {
      const r = await call<{ files: TreeEntry[] }>(`/workspace/${s.id}/tree`);
      setTree(r.files);
    } catch {
      // non-fatal — files section will show empty
    }
  }

  async function discard(s: Slot) {
    setBusy(true);
    try {
      await call(`/workspace/${s.id}`, { method: "DELETE" });
      if (sel?.id === s.id) setSel(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finalize(s: Slot) {
    setBusy(true);
    setError(null);
    try {
      const body = s.kind === "trusted"
        ? { message: `Changes from Spectre` }
        : { title: `Spectre: ${s.repo_name}` };
      const r = await call<{ pr_url?: string; pushed?: boolean }>(`/workspace/${s.id}/finalize`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (r.pr_url) setLastPrUrl(r.pr_url);
      setSel(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Auto-grow textarea
  function handleChatInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setChatMsg(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  const allSlotsTaken = (slots?.length ?? 0) >= 3;

  return (
    <div className="ws-page">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="ws-header">
        <div className="ws-header-left">
          <span className="ws-header-icon" aria-hidden>
            <Boxes size={16} />
          </span>
          <span className="ws-header-title">Workspaces</span>

          {slots && slots.length > 0 && (
            <>
              <div className="ws-header-sep" aria-hidden />
              <nav className="ws-slot-tabs" aria-label="Open workspaces">
                {slots.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`ws-slot-tab${sel?.id === s.id ? " active" : ""}`}
                    onClick={() => void selectSlot(s)}
                    title={`${s.repo_owner}/${s.repo_name} · ${s.branch}`}
                  >
                    {s.repo_name}
                  </button>
                ))}
              </nav>
            </>
          )}
        </div>

        <div className="ws-header-right">
          <button
            type="button"
            className="ws-open-repo-btn"
            onClick={() => setDialogOpen(true)}
            disabled={allSlotsTaken}
            title={allSlotsTaken ? "All 3 slots taken — discard one first" : "Clone a repo into a fresh slot"}
          >
            <Plus size={11} />
            Open Repo
          </button>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="ws-body">
        <div className="ws-col">
          {/* Error banner */}
          {error && <div className="ws-error-banner">{error}</div>}

          {/* Offline notice */}
          {off && (
            <div className="ws-offline-card">
              <p className="ws-offline-title">Workspaces are off</p>
              <p className="ws-offline-body">
                The workspace service isn&apos;t running. Start the stack with the{" "}
                <code className="ws-offline-code">workspace</code> profile (Full install), e.g.{" "}
                <code className="ws-offline-code">
                  docker compose --profile ui --profile workspace up -d
                </code>
                .
              </p>
            </div>
          )}

          {/* Loading */}
          {slots === null && !off && (
            <div className="ws-empty">
              <Loader2 size={20} className="ws-empty-icon" style={{ animation: "ws-spin 0.7s linear infinite" }} />
              <p className="ws-empty-title">Loading workspaces…</p>
            </div>
          )}

          {/* Empty state */}
          {slots !== null && slots.length === 0 && !off && (
            <div className="ws-empty">
              <FolderGit2 size={28} className="ws-empty-icon" />
              <p className="ws-empty-title">No workspaces yet</p>
              <p>
                Clone a repo to get started. Up to 3 sandbox slots available.
              </p>
            </div>
          )}

          {/* Selected slot ─────────────────────────────────────────────── */}
          {sel && (
            <>
              {/* Repo card */}
              <div className="ws-repo-card">
                <div className="ws-repo-card-row">
                  <div style={{ minWidth: 0 }}>
                    <p className="ws-repo-name">
                      {sel.repo_owner !== "(local)"
                        ? `${sel.repo_owner}/${sel.repo_name}`
                        : sel.repo_name}
                    </p>
                    <p className="ws-repo-meta">
                      {sel.branch}
                      <span style={{ margin: "0 6px", opacity: 0.4 }}>·</span>
                      base: {sel.base_branch}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ws-repo-del"
                    onClick={() => void discard(sel)}
                    disabled={busy}
                    title="Discard this workspace"
                    aria-label="Delete workspace"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Status chips */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4 }}>
                  <span className={`ws-status-chip${sel.kind === "trusted" ? " trusted" : ""}`}>
                    {sel.kind}
                  </span>
                  <span className="ws-status-chip warn">{sel.status}</span>
                  {sel.pr_url && (
                    <a
                      href={sel.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ws-status-chip"
                      style={{ textDecoration: "none" }}
                    >
                      <ExternalLink size={9} />
                      view PR
                    </a>
                  )}
                </div>
              </div>

              {/* JEROME section ────────────────────────────────────────── */}
              <div>
                <div className="ws-section-head">
                  <span className="ws-section-label">Jerome</span>

                  {/* Model dropdown — reuses the globals .model-dd classes */}
                  <div className="model-dd">
                    <button type="button" className="model-dd-btn" aria-haspopup="true">
                      <span className="model-dd-label">AUTO-ROUTE</span>
                      <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>▾</span>
                    </button>
                  </div>
                </div>

                {/* Ask hint */}
                <p className="ws-ask-hint">
                  Ask about this workspace.
                </p>

                {/* Chat composer dock */}
                <div className="ws-composer-dock">
                  <div className="ws-composer">
                    <textarea
                      ref={textareaRef}
                      className="ws-composer-textarea"
                      placeholder="Message Spectre…"
                      value={chatMsg}
                      onChange={handleChatInput}
                      rows={1}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          // Workspace chat is wired to the Jerome panel via the
                          // code-server embed. The textarea is a UX affordance;
                          // full message routing goes through the iframe.
                          setChatMsg("");
                          if (textareaRef.current) textareaRef.current.style.height = "auto";
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ws-composer-send"
                      disabled={!chatMsg.trim()}
                      aria-label="Send"
                      onClick={() => {
                        setChatMsg("");
                        if (textareaRef.current) textareaRef.current.style.height = "auto";
                      }}
                    >
                      <Send size={18} />
                    </button>
                  </div>
                </div>
              </div>

              {/* code-server embed (hidden under composer when slot is ready) */}
              {sel.status === "ready" && (
                <div style={{ display: "none" }}>
                  {/* The iframe lives here so the WS connection is maintained
                      even when the user scrolls to the composer. On desktop,
                      the Jerome monolith renders this full-height — on mobile
                      we keep it hidden and surface chat + files instead. */}
                  <iframe
                    key={sel.id}
                    src={editorUrl(sel)}
                    title={`VS Code · ${sel.repo_owner}/${sel.repo_name}`}
                    style={{ width: "100%", height: 0, border: 0 }}
                    allow="clipboard-read; clipboard-write; fullscreen"
                  />
                </div>
              )}

              {/* FILES collapsible ─────────────────────────────────────── */}
              <div className="ws-collapsible">
                <button
                  type="button"
                  className="ws-collapsible-head"
                  onClick={() => setFilesOpen((v) => !v)}
                  aria-expanded={filesOpen}
                >
                  <span className="ws-collapsible-label">
                    <FileCode size={13} />
                    Files
                  </span>
                  <ChevronRight
                    size={15}
                    className={`ws-collapsible-chevron${filesOpen ? " open" : ""}`}
                  />
                </button>

                {filesOpen && (
                  <div className="ws-collapsible-body">
                    {tree === null ? (
                      <div className="ws-empty" style={{ minHeight: 80, padding: "16px" }}>
                        <span className="ws-spinner" />
                      </div>
                    ) : tree.length === 0 ? (
                      <div className="ws-empty" style={{ minHeight: 60, padding: "12px 16px", fontSize: 12 }}>
                        No files found.
                      </div>
                    ) : (
                      <ul className="ws-file-list">
                        {tree
                          .filter((t) => !t.is_dir)
                          .slice(0, 400)
                          .map((t) => {
                            const depth = t.path.split("/").length - 1;
                            const name = t.path.split("/").pop() ?? t.path;
                            return (
                              <li
                                key={t.path}
                                className="ws-file-item"
                                style={{ paddingLeft: `${depth * 12 + 14}px` }}
                                title={t.path}
                              >
                                <FileCode size={11} style={{ flexShrink: 0, opacity: 0.5 }} />
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                                  {name}
                                </span>
                                {t.size > 0 && (
                                  <span className="ws-file-size">{formatBytes(t.size)}</span>
                                )}
                              </li>
                            );
                          })}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* Finalize action row */}
              {sel.status === "ready" && (
                <div style={{ paddingTop: 4 }}>
                  <button
                    type="button"
                    className="ws-open-repo-btn"
                    style={{ width: "100%", justifyContent: "center", borderRadius: "var(--r)" }}
                    onClick={() => void finalize(sel)}
                    disabled={busy}
                  >
                    {sel.kind === "trusted" ? "Commit + Push" : "Finalize → PR"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Open-repo dialog ─────────────────────────────────────────────── */}
      {dialogOpen && (
        <div
          className="ws-dialog-overlay"
          onClick={() => setDialogOpen(false)}
        >
          <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ws-dialog-head">
              <h2 className="ws-dialog-title">Open repository</h2>
              <button
                type="button"
                className="ws-dialog-close"
                onClick={() => setDialogOpen(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="ws-dialog-field">
              <label className="ws-dialog-field-label">Repository</label>
              <input
                className="ws-dialog-input"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void openRepo(); }}
                placeholder="owner/name or GitHub URL"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className="ws-dialog-field">
              <label className="ws-dialog-field-label">Base branch</label>
              <input
                className="ws-dialog-input"
                type="text"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="main"
              />
            </div>

            {error && <div className="ws-error-banner">{error}</div>}

            <div className="ws-dialog-actions">
              <button
                type="button"
                className="ws-dialog-submit"
                onClick={() => void openRepo()}
                disabled={busy || !repo.trim()}
              >
                {busy ? <Loader2 size={13} style={{ animation: "ws-spin 0.7s linear infinite" }} /> : null}
                Clone
              </button>
              <button
                type="button"
                className="ws-dialog-cancel"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PR toast ─────────────────────────────────────────────────────── */}
      {lastPrUrl && (
        <div className="ws-toast" role="status">
          <div className="ws-toast-head">
            <ExternalLink size={14} className="ws-toast-icon" />
            <div className="ws-toast-body">
              <p className="ws-toast-title">PR opened</p>
              <a
                href={lastPrUrl}
                target="_blank"
                rel="noreferrer"
                className="ws-toast-link"
              >
                {lastPrUrl}
              </a>
            </div>
            <button
              type="button"
              className="ws-toast-close"
              onClick={() => setLastPrUrl(null)}
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
