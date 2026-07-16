"use client";

import "./workspace.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/sdk";
import { WorkspaceChatPanel } from "./WorkspaceChatPanel";
import {
  Boxes,
  ExternalLink,
  FolderGit2,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
  X,
} from "lucide-react";

/**
 * Workspace tab. Lists workspace slots (sandbox clones + trusted local folders)
 * and embeds the real VS Code (code-server) for the selected slot via an iframe
 * pointed at the Caddy edge (NEXT_PUBLIC_CODE_SERVER_URL, default the edge's
 * /code path). code-server sends no X-Frame-Options / frame-ancestors, so the
 * absolute edge URL can be framed cross-origin — the editor renders whether
 * Spectre is opened on the shell port (:3100) or the edge (:8090).
 *   - /workspace/slots       → slot list
 *   - /workspace/open        → POST open repo (sandbox)
 *   - /workspace/{id}/finalize → PR / push
 *   - DELETE /workspace/{id} → discard
 */

// Where the embedded editor (code-server) is served — the Caddy edge. Absolute
// URL (e.g. http://127.0.0.1:8090/code) so the iframe works from any shell port.
const CODE_SERVER_BASE = (process.env.NEXT_PUBLIC_CODE_SERVER_URL || "/code").replace(/\/+$/, "");

interface Slot {
  id: string;
  kind: "sandbox" | "trusted";
  repo_owner: string;
  repo_name: string;
  branch: string;
  base_branch: string;
  status: string;
  repo_url?: string | null;
  pr_url?: string | null;
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

  // ── Finalize (PR) ──────────────────────────────────────────────────────────
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);

  // The VS Code (code-server) URL for a slot. Trusted folders open at their
  // registered absolute path; sandbox clones open under /workspaces.
  const editorUrl = (s: Slot) => {
    const folder = s.kind === "trusted" ? (s.repo_url || "") : `/workspaces/${s.id}/repo`;
    return `${CODE_SERVER_BASE}/${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await call<{ slots: Slot[] }>("/workspace/slots");
      setSlots(r.slots);
      setOff(false);
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

  // Fullscreen the editor pane (browser Fullscreen API on the work area).
  const workareaRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === workareaRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void workareaRef.current?.requestFullscreen();
  };

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
                    onClick={() => setSel(s)}
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
          {error && <div className="ws-error-banner">{error}</div>}

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

          {slots === null && !off && (
            <div className="ws-empty">
              <Loader2 size={20} className="ws-empty-icon" style={{ animation: "ws-spin 0.7s linear infinite" }} />
              <p className="ws-empty-title">Loading workspaces…</p>
            </div>
          )}

          {slots !== null && slots.length === 0 && !off && (
            <div className="ws-empty">
              <FolderGit2 size={28} className="ws-empty-icon" />
              <p className="ws-empty-title">No workspaces yet</p>
              <p>Clone a repo, or mount a trusted folder, to get started.</p>
            </div>
          )}

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
                      {sel.branch || sel.kind}
                      <span style={{ margin: "0 6px", opacity: 0.4 }}>·</span>
                      {sel.kind === "trusted" ? "trusted folder" : `base: ${sel.base_branch}`}
                    </p>
                  </div>
                  <div className="ws-card-actions">
                    {sel.status === "ready" && (
                      <button
                        type="button"
                        className="ws-repo-del"
                        onClick={toggleFs}
                        title="Fullscreen editor"
                        aria-label="Fullscreen editor"
                      >
                        <Maximize2 size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="ws-repo-del"
                      onClick={() => void discard(sel)}
                      disabled={busy || sel.kind === "trusted"}
                      title={sel.kind === "trusted" ? "Trusted folders can't be discarded" : "Discard this workspace"}
                      aria-label="Delete workspace"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

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

              {/* Embedded VS Code (code-server) */}
              {sel.status === "ready" && (
                <div className="ws-workarea" ref={workareaRef}>
                  <div className="ws-editor-pane">
                    <iframe
                      key={sel.id}
                      src={editorUrl(sel)}
                      title={`VS Code · ${sel.repo_name}`}
                      className="ws-editor-iframe"
                      allow="clipboard-read; clipboard-write; fullscreen"
                    />
                    {isFs && (
                      <button type="button" className="ws-fs-exit" onClick={toggleFs}>
                        <Minimize2 size={13} /> Exit fullscreen
                      </button>
                    )}
                  </div>
                  <WorkspaceChatPanel slot={sel} />
                </div>
              )}

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
        <div className="ws-dialog-overlay" onClick={() => setDialogOpen(false)}>
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
              <a href={lastPrUrl} target="_blank" rel="noreferrer" className="ws-toast-link">
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
