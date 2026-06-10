"use client";

import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/sdk";
import {
  TabShell,
  Panel,
  ListRow,
  Chip,
  Button,
  Input,
  Field,
  Toolbar,
  Segmented,
  EmptyState,
  Skeleton,
  ErrorState,
} from "@/components/ui";
import { FolderGit2, GitPullRequest, Trash2, RefreshCw, FileCode, Code2, ExternalLink } from "lucide-react";

/**
 * Workspace module — the in-browser IDE. Manages the opt-in workspace-service
 * (sandbox repo clones → PR, and TRUSTED local folders → push) and embeds
 * code-server (VS Code in the browser) as the editor — same approach as the
 * Spectre monolith's /code route. code-server gives the editor + integrated
 * terminal + git diff + test-running in one; a lightweight Files tab is kept as
 * a no-Docker fallback. Built on the kit + the /api/workspace proxy; degrades to
 * an "off" notice when the workspace compose profile isn't running.
 *
 * The editor loads from NEXT_PUBLIC_CODE_SERVER_URL (default "/code", a
 * same-origin path the edge proxy maps to the code-server container — required
 * for WebSockets + HTTPS/tailnet; see deploy/Caddyfile + M6-INSTALLER).
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

export default function WorkspaceTab() {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Slot | null>(null);
  const [slotTab, setSlotTab] = useState<"editor" | "files">("editor");
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [title, setTitle] = useState("");

  // code-server opens the repo dir. Sandbox slots live at <root>/<id>/repo;
  // trusted folders open at the editor's default tree (their bind-mounted path).
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/503/.test(msg)) setOff(true);
      else setError(msg);
      setSlots([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openRepo() {
    if (!repo.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await call("/workspace/open", { method: "POST", body: JSON.stringify({ repo: repo.trim(), base_branch: base.trim() || "main" }) });
      setRepo("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function selectSlot(s: Slot) {
    setSel(s);
    setSlotTab("editor");
    setTree(null);
    setFile(null);
    try {
      const r = await call<{ files: TreeEntry[] }>(`/workspace/${s.id}/tree`);
      setTree(r.files);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function viewFile(path: string) {
    if (!sel) return;
    try {
      // The file endpoint returns raw text (not JSON), so fetch it directly.
      const res = await fetch(`/api/workspace/${sel.id}/file?path=${encodeURIComponent(path)}`);
      if (res.headers.get("X-File-Binary") === "1") {
        setFile({ path, text: "(binary file)" });
        return;
      }
      setFile({ path, text: (await res.text()).slice(0, 20000) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function finalize(s: Slot) {
    setBusy(true);
    setError(null);
    try {
      const body = s.kind === "trusted" ? { message: title || "Changes from Spectre" } : { title: title || `Spectre: ${s.repo_name}` };
      const r = await call<{ pr_url?: string; pushed?: boolean }>(`/workspace/${s.id}/finalize`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTitle("");
      if (r.pr_url) window.open(r.pr_url, "_blank");
      setSel(null);
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

  const sandboxCount = slots?.filter((s) => s.kind === "sandbox").length ?? 0;

  return (
    <TabShell
      title="Workspace"
      eyebrow="SYSTEM · WORKSPACE"
      status={off ? "offline" : `${slots?.length ?? 0} slots`}
      tone={off ? "off" : "ok"}
    >
      {off ? (
        <Panel label="WORKSPACE" title="Workspaces are off" icon={<FolderGit2 size={16} />}>
          <EmptyState>
            The workspace service isn&apos;t running. Start the stack with the{" "}
            <code>workspace</code> profile (Full install), e.g.{" "}
            <code>docker compose --profile ui --profile workspace up -d</code>.
          </EmptyState>
        </Panel>
      ) : (
        <>
          {error && <ErrorState>{error}</ErrorState>}

          <Panel label="NEW" title="Open a repo (sandbox)" icon={<FolderGit2 size={16} />}>
            <Field label="repository">
              <Input placeholder="owner/name or GitHub URL" value={repo} onChange={(e) => setRepo(e.target.value)} />
            </Field>
            <Field label="base branch">
              <Input placeholder="main" value={base} onChange={(e) => setBase(e.target.value)} />
            </Field>
            <Toolbar style={{ marginTop: 10 }}>
              <Button onClick={openRepo} disabled={busy || !repo.trim()}>
                {busy ? "Working…" : "Clone into sandbox"}
              </Button>
              <Button variant="ghost" onClick={() => void load()}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </Toolbar>
            {sandboxCount >= 3 && <EmptyState>All 3 sandbox slots are in use — finalize or discard one first.</EmptyState>}
          </Panel>

          <Panel label="SLOTS" title="Workspaces" icon={<FolderGit2 size={16} />}>
            {slots === null ? (
              <Skeleton height={120} />
            ) : slots.length === 0 ? (
              <EmptyState>No workspaces yet. Clone a repo above, or register a trusted folder via WORKSPACE_TRUSTED_DIRS.</EmptyState>
            ) : (
              slots.map((s) => (
                <ListRow
                  key={s.id}
                  head={
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <FolderGit2 size={14} />
                      {s.repo_owner !== "(local)" ? `${s.repo_owner}/${s.repo_name}` : s.repo_name}
                      <Chip on color={s.kind === "trusted" ? "#818cf8" : undefined}>{s.kind}</Chip>
                      <Chip>{s.status}</Chip>
                    </span>
                  }
                  when={s.branch || ""}
                  onClick={() => void selectSlot(s)}
                >
                  {s.pr_url && (
                    <a href={s.pr_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent-bright)" }}>
                      view PR
                    </a>
                  )}
                </ListRow>
              ))
            )}
          </Panel>

          {sel && (
            <Panel label={`SLOT · ${sel.id}`} title={`${sel.repo_owner !== "(local)" ? sel.repo_owner + "/" : ""}${sel.repo_name}`} icon={<FileCode size={16} />}>
              <Toolbar style={{ marginBottom: 10, flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <Segmented
                  value={slotTab}
                  onChange={setSlotTab}
                  options={[
                    { value: "editor", label: "Editor" },
                    { value: "files", label: "Files" },
                  ]}
                />
                <div style={{ flex: 1, minWidth: 8 }} />
                <Input placeholder={sel.kind === "trusted" ? "commit message" : "PR title"} value={title} onChange={(e) => setTitle(e.target.value)} />
                <Button onClick={() => void finalize(sel)} disabled={busy}>
                  <GitPullRequest size={14} /> {sel.kind === "trusted" ? "Commit + push" : "Finalize → PR"}
                </Button>
                {sel.kind === "sandbox" && (
                  <Button variant="danger" onClick={() => void discard(sel)} disabled={busy}>
                    <Trash2 size={14} /> Discard
                  </Button>
                )}
              </Toolbar>

              {slotTab === "editor" ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 8,
                      fontSize: 11.5,
                      color: "var(--color-text-muted)",
                    }}
                  >
                    <Code2 size={13} />
                    <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      VS Code · {sel.kind === "sandbox" ? `/workspaces/${sel.id}/repo` : sel.repo_name}
                    </span>
                    <div style={{ flex: 1 }} />
                    <a
                      href={editorUrl(sel)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--accent-bright)" }}
                    >
                      <ExternalLink size={12} /> open in tab
                    </a>
                  </div>
                  <iframe
                    src={editorUrl(sel)}
                    title="code-server"
                    style={{
                      width: "100%",
                      height: 560,
                      border: "1px solid var(--ink-faint)",
                      borderRadius: 10,
                      background: "var(--color-bg)",
                      display: "block",
                    }}
                  />
                  <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-text-muted)" }}>
                    Editor blank? The embedded VS Code needs the <code>workspace</code> profile running and the
                    edge proxy serving <code>{CODE_SERVER_BASE}</code> (WebSockets + HTTPS). See M6-INSTALLER →
                    Workspaces. The <b>Files</b> tab works without it.
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 12 }}>
                  <div style={{ maxHeight: 360, overflow: "auto" }}>
                    {tree === null ? (
                      <Skeleton height={200} />
                    ) : (
                      tree
                        .filter((t) => !t.is_dir)
                        .slice(0, 400)
                        .map((t) => (
                          <ListRow key={t.path} onClick={() => void viewFile(t.path)}>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.path}</span>
                          </ListRow>
                        ))
                    )}
                  </div>
                  <div style={{ maxHeight: 360, overflow: "auto" }}>
                    {file ? (
                      <>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, opacity: 0.7, marginBottom: 6 }}>{file.path}</div>
                        <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {file.text}
                        </pre>
                      </>
                    ) : (
                      <EmptyState>Pick a file to view it, or switch to the Editor tab for full VS Code.</EmptyState>
                    )}
                  </div>
                </div>
              )}
            </Panel>
          )}
        </>
      )}
    </TabShell>
  );
}
