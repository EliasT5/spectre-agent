"use client";

import "./chat.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  ArrowUp,
  Square,
  ShieldAlert,
  Paperclip,
  FileText,
  X,
  Sparkles,
  Layers,
  ChevronDown,
  Check,
  ChevronRight,
  Wrench,
  ArrowLeft,
  Loader2,
  MoreVertical,
  FolderPlus,
  Archive,
} from "lucide-react";
import { SpectreBackButton } from "@/components/SpectreBackButton";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { subscribeThreadStream } from "@/lib/thread-stream";
import { CategorySheet } from "./CategorySheet";
import { ThreadActionSheet } from "./ThreadActionSheet";
import { type Thread, type Category } from "./types";

/**
 * Real chat: a thread list you can revisit + a durable, live-streamed
 * conversation. Enqueue through the core; watch the rows fill via the core's
 * SSE thread stream (survives disconnects — the run is runner+core+DB). The
 * composer is NEVER disabled — sending always enqueues, so you can pipeline
 * follow-ups while a turn is still working; a queued turn renders dimmed with a
 * position pill, and a floating Stop targets the one running turn. Assistant
 * text is markdown; tool_use/tool_result parts render as collapsible chips in
 * their original order so the orchestration is visible. The browser never
 * talks to storage: everything rides /api/* through the PIN-gated proxy.
 */

type Part =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

type Msg = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  status: string | null;
  tool_calls: Part[] | null;
  created_at: string;
};

type PendingReq = { reqId: string; threadId: string; tool: string; input?: unknown; createdAt: number };
type PdfDoc = { id: string; filename: string; title: string | null; status: string };
type ModelOption = {
  id: string;
  label: string;
  available?: boolean;
  unavailableReason?: string;
  reasoning?: boolean;
  effortLevels?: string[];
};

const AUTO_MODEL: ModelOption = { id: "", label: "Auto · default route" };
const THINKING_VERBS = ["thinking…", "reasoning…", "working…", "reading…"];

/* ─────────────────────────── date grouping ─────────────────────────────── */
function groupByDate(threads: Thread[]) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const fmt = (d: Date) => d.toDateString();

  const groups: Record<string, Thread[]> = {
    Today: [],
    Yesterday: [],
    "This Week": [],
    Earlier: [],
  };
  for (const t of threads) {
    const d = new Date(t.updated_at ?? t.created_at);
    if (fmt(d) === fmt(today)) groups.Today.push(t);
    else if (fmt(d) === fmt(yesterday)) groups.Yesterday.push(t);
    else if (d >= weekAgo) groups["This Week"].push(t);
    else groups.Earlier.push(t);
  }
  return Object.entries(groups).filter(([, v]) => v.length > 0);
}

function formatTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffHours = (now.getTime() - date.getTime()) / 3_600_000;
  if (diffHours < 24) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROOT COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
export default function ChatTab() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingReq[]>([]);
  const [pdfs, setPdfs] = useState<PdfDoc[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([AUTO_MODEL]);
  const [modelOpen, setModelOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // Categories (backed by the `projects` table) + which channel is active.
  // activeCat: "all" | "uncat" | "archived" | <categoryId>.
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCat, setActiveCat] = useState<string>("all");
  const [catSheetOpen, setCatSheetOpen] = useState(false);
  const [actionThread, setActionThread] = useState<Thread | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelDdRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Load BOTH buckets in one fetch — non-archived drive the category channels,
  // archived drive the "Archived" channel; we split them client-side.
  const loadThreads = async () => {
    const r = await fetch("/api/threads?archived=all");
    if (r.ok) {
      const data = await r.json();
      const arr: Thread[] = Array.isArray(data) ? data : data.threads ?? [];
      setThreads(arr);
    }
  };
  useEffect(() => {
    loadThreads();
  }, []);

  // Categories.
  const loadCategories = async () => {
    try {
      const r = await fetch("/api/projects");
      if (!r.ok) return;
      const d = await r.json();
      setCategories(Array.isArray(d) ? d : d.projects ?? []);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    loadCategories();
  }, []);

  // Don't strand the user on a channel that no longer has a pill. The
  // UNCATEGORIZED/ARCHIVED pills only render while they have chats, and a
  // category pill vanishes if the category is deleted — snap back to ALL so the
  // list never goes blank with nothing selected.
  useEffect(() => {
    const gone =
      (activeCat === "archived" && !threads.some((t) => t.archived)) ||
      (activeCat === "uncat" && !threads.some((t) => !t.archived && !t.project_id)) ||
      (!["all", "uncat", "archived"].includes(activeCat) && !categories.some((c) => c.id === activeCat));
    if (gone) setActiveCat("all");
  }, [threads, categories, activeCat]);

  // Available models for the per-thread route override (from enriched /api/models).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/models");
        if (!r.ok) return;
        const d = await r.json();
        const raw: Array<{
          id: string;
          displayName?: string;
          available?: boolean;
          unavailableReason?: string;
          reasoning?: boolean;
          effortLevels?: string[];
        }> = Array.isArray(d?.models) ? d.models : [];
        const options: ModelOption[] = raw
          .filter((m) => m && typeof m.id === "string")
          .map((m) => ({
            id: m.id,
            label: m.displayName ?? m.id,
            available: m.available,
            unavailableReason: m.unavailableReason,
            reasoning: m.reasoning,
            effortLevels: m.effortLevels,
          }));
        if (!cancelled && options.length) setModels([AUTO_MODEL, ...options]);
      } catch {
        /* keep just Auto */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ready PDFs available to attach as a reading session.
  const loadPdfs = async () => {
    try {
      const r = await fetch("/api/pdfs");
      if (!r.ok) return;
      const d = await r.json();
      const arr: PdfDoc[] = Array.isArray(d) ? d : d.documents ?? [];
      setPdfs(arr.filter((p) => p.status === "ready"));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    loadPdfs();
  }, []);

  // Reflect the current thread's attached PDFs (from its metadata).
  useEffect(() => {
    if (!threadId) {
      setAttached([]);
      setShowPicker(false);
      return;
    }
    const t = threads.find((x) => x.id === threadId);
    setAttached(Array.isArray(t?.metadata?.pdf_ids) ? (t!.metadata!.pdf_ids as string[]) : []);
  }, [threadId, threads]);

  // Load + live-subscribe the selected thread (snapshot + row events over SSE).
  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    atBottomRef.current = true;
    const upsert = (row: Msg) =>
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === row.id);
        const next = i === -1 ? [...prev, row] : prev.map((m) => (m.id === row.id ? { ...m, ...row } : m));
        return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      });

    return subscribeThreadStream<Msg>(threadId, {
      onSnapshot: setMessages,
      onRow: upsert,
    });
  }, [threadId]);

  // HITL approval gate: poll in-flight tool-approval requests for this thread.
  useEffect(() => {
    if (!threadId) {
      setPending([]);
      return;
    }
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/permission/pending");
        if (!r.ok) return;
        const { items } = await r.json();
        if (!stop) setPending((items ?? []).filter((p: PendingReq) => p.threadId === threadId));
      } catch {
        /* ignore poll errors */
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [threadId]);

  // Close the model menu on an outside click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (modelDdRef.current && !modelDdRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelOpen]);

  // Stick to bottom on new content — but only if the user hasn't scrolled up.
  useLayoutEffect(() => {
    if (atBottomRef.current && threadId) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, threadId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Autoresize the textarea (cap 160px; CSS handles overflow past the cap).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  const running = messages.find((m) => m.role === "assistant" && m.status === "running");
  const queuedAssistants = messages
    .filter((m) => m.role === "assistant" && m.status === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const queueCount = queuedAssistants.length;
  const queuePos = new Map(queuedAssistants.map((m, i) => [m.id, i + 1]));

  const currentThread = threads.find((t) => t.id === threadId);
  const currentModelId = currentThread?.model_hint ?? "";
  const currentModel = models.find((m) => m.id === currentModelId) ?? AUTO_MODEL;
  const currentReasoningEffort = currentThread?.reasoning_effort ?? "";
  const showEffortPicker = currentModel.reasoning === true && Array.isArray(currentModel.effortLevels) && currentModel.effortLevels.length > 0;

  // A new chat inherits the active category (only a real category id counts —
  // "all"/"uncat"/"archived" seed no project).
  const activeCatId = categories.some((c) => c.id === activeCat) ? activeCat : null;

  async function startNewThread() {
    if (creating) return;
    setCreating(true);
    try {
      const r = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New chat", project_id: activeCatId }),
      });
      if (r.ok) {
        const t = await r.json();
        setMessages([]);
        setThreadId(t.id);
        await loadThreads();
      }
    } finally {
      setCreating(false);
    }
  }

  function openThread(id: string) {
    setThreadId(id);
    setMessages([]);
  }

  function backToList() {
    setThreadId(null);
    setMessages([]);
    setModelOpen(false);
  }

  const patchThreadLocal = (id: string, patch: Partial<Thread>) =>
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /* ── Category (projects) CRUD ── */
  async function createCategory(v: { name: string; description: string; color: string }) {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    }).catch(() => {});
    await loadCategories();
  }
  async function updateCategory(id: string, v: { name: string; description: string; color: string }) {
    await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    }).catch(() => {});
    await loadCategories();
  }
  async function deleteCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    // Optimistically re-home this category's chats to Uncategorized (mirrors the
    // server). Do NOT loadThreads() here: a full refetch in list mode could
    // clobber an in-flight optimistic rename/move/archive on another chat.
    setThreads((prev) => prev.map((t) => (t.project_id === id ? { ...t, project_id: null } : t)));
    if (activeCat === id) setActiveCat("all");
    const r = await fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => null);
    if (!r || !r.ok) await Promise.all([loadCategories(), loadThreads()]);
    else await loadCategories();
  }

  /* ── Per-chat management (rename / move / archive / delete) ──
     All reuse the existing PATCH/DELETE /threads/:id. Optimistic; on a network
     failure we reconcile by reloading. Rename/move/archive intentionally do NOT
     refetch, so a renamed chat doesn't jump to the top of the updated_at order. */
  async function renameThread(id: string, title: string) {
    patchThreadLocal(id, { title });
    await fetch(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => loadThreads());
  }
  async function moveThread(id: string, projectId: string | null) {
    patchThreadLocal(id, { project_id: projectId });
    await fetch(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    }).catch(() => loadThreads());
  }
  async function setThreadArchived(id: string, archived: boolean) {
    patchThreadLocal(id, { archived });
    await fetch(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }).catch(() => loadThreads());
  }
  async function deleteThread(id: string) {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (threadId === id) backToList();
    const r = await fetch(`/api/threads/${id}`, { method: "DELETE" }).catch(() => null);
    if (!r || !r.ok) loadThreads();
  }

  function startRename(id: string) {
    const t = threads.find((x) => x.id === id);
    setRenameVal(t?.title?.trim() || "");
    setRenameId(id);
  }
  function commitRename() {
    if (renameId == null) return;
    const id = renameId;
    const v = renameVal.trim();
    setRenameId(null);
    const cur = threads.find((x) => x.id === id);
    if (v && v !== (cur?.title ?? "")) renameThread(id, v);
  }

  async function ensureThread(seedTitle?: string): Promise<string | null> {
    if (threadId) return threadId;
    const r = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: seedTitle?.slice(0, 60) || "New chat", project_id: activeCatId }),
    });
    if (!r.ok) return null;
    const tid = (await r.json()).id;
    setThreadId(tid);
    loadThreads();
    return tid;
  }

  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput("");
    atBottomRef.current = true;
    const tid = await ensureThread(content);
    if (!tid) return;
    await fetch(`/api/threads/${tid}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  async function selectModel(id: string) {
    setModelOpen(false);
    const tid = await ensureThread();
    if (!tid) return;
    setThreads((prev) => prev.map((t) => (t.id === tid ? { ...t, model_hint: id || null } : t)));
    await fetch(`/api/threads/${tid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_hint: id || null }),
    }).catch(() => {});
  }

  async function selectEffort(level: string) {
    const tid = await ensureThread();
    if (!tid) return;
    setThreads((prev) => prev.map((t) => (t.id === tid ? { ...t, reasoning_effort: level || null } : t)));
    await fetch(`/api/threads/${tid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_effort: level || null }),
    }).catch(() => {});
  }

  async function toggleAttach(id: string) {
    const tid = await ensureThread();
    if (!tid) return;
    const next = attached.includes(id) ? attached.filter((x) => x !== id) : [...attached, id];
    setAttached(next);
    await fetch(`/api/threads/${tid}/attach-pdfs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_ids: next, mode: "set" }),
    }).catch(() => {});
    loadThreads();
  }

  const docLabel = (id: string) => {
    const d = pdfs.find((p) => p.id === id);
    return d?.title?.trim() || d?.filename || `${id.slice(0, 8)}…`;
  };

  async function stop() {
    if (!threadId || !running) return;
    await fetch(`/api/threads/${threadId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: running.id }),
    });
  }

  async function decide(reqId: string, decision: "allow" | "deny" | "allow_session") {
    if (!threadId) return;
    setPending((prev) => prev.filter((p) => p.reqId !== reqId));
    await fetch(`/api/threads/${threadId}/permission/${reqId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => {});
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  /* ── LIST MODE ── */
  if (!threadId) {
    const live = threads.filter((t) => !t.archived);
    const arch = threads.filter((t) => t.archived);
    const hasCats = categories.length > 0;
    const uncatCount = live.filter((t) => !t.project_id).length;
    const archivedView = activeCat === "archived";
    const filtered =
      activeCat === "all"
        ? live
        : activeCat === "uncat"
          ? live.filter((t) => !t.project_id)
          : archivedView
            ? arch
            : live.filter((t) => t.project_id === activeCat);
    const grouped = groupByDate(filtered);
    return (
      <div className="chat-list-page">
        <SpectreBackButton />
        <div className="chat-list-col">
          {/* Header */}
          <header className="chat-list-header">
            <div className="chat-list-titles">
              <span className="chat-eyebrow">AT YOUR SERVICE</span>
              <h1 className="chat-display-title">Spectre</h1>
              <p className="chat-conv-count">
                {live.length > 0
                  ? `${live.length} conversation${live.length === 1 ? "" : "s"}`
                  : "Ready when you are"}
              </p>
            </div>
            <button
              className="chat-newbtn tap-press"
              onClick={startNewThread}
              disabled={creating}
              aria-label="New conversation"
            >
              {creating ? (
                <Loader2 size={20} strokeWidth={2} className="spin-icon" />
              ) : (
                <Plus size={20} strokeWidth={2.2} />
              )}
            </button>
          </header>

          <div className="hairline-gradient" style={{ margin: "0 20px" }} />

          {/* Category channel strip: ALL · categories · Uncategorized · Archived, with a pinned manage-"+" */}
          <div className="chat-seg-row">
            <div className="chat-seg-scroll">
              <div className="seg chat-seg">
                <button className={activeCat === "all" ? "on" : ""} aria-pressed={activeCat === "all"} onClick={() => setActiveCat("all")}>
                  <MessageSquare size={13} strokeWidth={1.8} />
                  <span>ALL</span>
                  <span className="seg-count">{live.length}</span>
                </button>
                {categories.map((c) => {
                  const n = live.filter((t) => t.project_id === c.id).length;
                  return (
                    <button
                      key={c.id}
                      className={activeCat === c.id ? "on" : ""}
                      aria-pressed={activeCat === c.id}
                      onClick={() => setActiveCat(c.id)}
                    >
                      <span className="chat-seg-dot" style={{ background: c.color ?? "#6366f1" }} />
                      <span>{c.name}</span>
                      <span className="seg-count">{n}</span>
                    </button>
                  );
                })}
                {hasCats && uncatCount > 0 && (
                  <button className={activeCat === "uncat" ? "on" : ""} aria-pressed={activeCat === "uncat"} onClick={() => setActiveCat("uncat")}>
                    <span>UNCATEGORIZED</span>
                    <span className="seg-count">{uncatCount}</span>
                  </button>
                )}
                {arch.length > 0 && (
                  <button className={activeCat === "archived" ? "on" : ""} aria-pressed={activeCat === "archived"} onClick={() => setActiveCat("archived")}>
                    <Archive size={13} strokeWidth={1.8} />
                    <span>ARCHIVED</span>
                    <span className="seg-count">{arch.length}</span>
                  </button>
                )}
              </div>
            </div>
            <button
              className="chat-seg-add tap-press"
              onClick={() => setCatSheetOpen(true)}
              aria-label="Manage categories"
              title="Manage categories"
            >
              <FolderPlus size={16} strokeWidth={1.8} />
            </button>
          </div>

          {/* Thread list */}
          <div className="chat-list-scroll">
            {threads.length === 0 ? (
              <div className="chat-list-empty">
                <div className="chat-list-empty-orb">
                  <span className="gradient-text" style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 600 }}>S</span>
                </div>
                <p style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text)" }}>Nothing yet.</p>
                <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>Shall we begin?</p>
                <button className="chat-list-start-btn tap-press" onClick={startNewThread}>
                  New conversation
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="chat-list-empty">
                <p style={{ fontSize: 14, color: "var(--color-text-muted)", paddingTop: 48 }}>
                  {archivedView ? "No archived chats." : "No chats in this category yet."}
                </p>
              </div>
            ) : (
              <div className="chat-list-groups">
                {grouped.map(([label, list]) => (
                  <section key={label} className="date-group">
                    <div className="date-label">{label}</div>
                    <ul className="thread-cards">
                      {list.map((t) => (
                        <li key={t.id}>
                          <div className="thread-card">
                            {renameId === t.id ? (
                              <input
                                className="thread-card-rename"
                                value={renameVal}
                                onChange={(e) => setRenameVal(e.target.value)}
                                onBlur={commitRename}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    commitRename();
                                  } else if (e.key === "Escape") {
                                    setRenameId(null);
                                  }
                                }}
                                maxLength={120}
                                aria-label="Rename chat"
                                // eslint-disable-next-line jsx-a11y/no-autofocus
                                autoFocus
                              />
                            ) : (
                              <button className="thread-card-hit tap-press" onClick={() => openThread(t.id)}>
                                <span className="thread-card-icon">
                                  <MessageSquare size={18} strokeWidth={1.8} />
                                </span>
                                <span className="thread-card-body">
                                  <span className="thread-card-title">
                                    {t.title?.trim() || "New conversation"}
                                  </span>
                                  <span className="thread-card-time">
                                    {formatTime(t.updated_at ?? t.created_at)}
                                  </span>
                                </span>
                              </button>
                            )}
                            {renameId !== t.id && (
                              <button
                                className="thread-card-menu tap-press"
                                onClick={() => setActionThread(t)}
                                aria-label="Chat actions"
                              >
                                <MoreVertical size={16} strokeWidth={1.8} />
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>

        {catSheetOpen && (
          <CategorySheet
            categories={categories}
            onCreate={createCategory}
            onUpdate={updateCategory}
            onDelete={deleteCategory}
            onClose={() => setCatSheetOpen(false)}
          />
        )}
        {actionThread && (
          <ThreadActionSheet
            thread={actionThread}
            categories={categories}
            archivedView={!!actionThread.archived}
            onClose={() => setActionThread(null)}
            onStartRename={startRename}
            onMove={moveThread}
            onArchive={(id) => setThreadArchived(id, true)}
            onUnarchive={(id) => setThreadArchived(id, false)}
            onDelete={deleteThread}
          />
        )}
      </div>
    );
  }

  /* ── CONVERSATION MODE ── */
  return (
    <div className="chat-conv-page">
      <SpectreBackButton />
      <div className="chat-conv-col">
        {/* Conversation header: back + model dropdown */}
        <header className="chat-header conv-header">
          <button
            className="conv-back tap-press"
            onClick={backToList}
            aria-label="Back to thread list"
          >
            <ArrowLeft size={18} strokeWidth={2} />
          </button>
          <div className="conv-header-title">
            {currentThread?.title?.trim() || "New chat"}
          </div>
          <div className="model-dd" ref={modelDdRef}>
            <button
              className="model-dd-btn"
              onClick={() => setModelOpen((o) => !o)}
              title="Model for this thread"
              aria-haspopup="listbox"
              aria-expanded={modelOpen}
            >
              <Layers size={14} strokeWidth={1.7} />
              <span className="model-dd-label">{currentModel.label}</span>
              <ChevronDown size={14} strokeWidth={1.7} style={{ opacity: 0.7 }} />
            </button>
            {modelOpen && (
              <div className="model-dd-menu" role="listbox">
                {/* Only show usable models: Auto + available + whatever's currently
                    selected. The full hardcoded catalog (Claude/GPT/Gemini/… you
                    haven't wired up) lives in Settings → Providers for enabling; the
                    chat picker stays "what you can actually use + what you added". */}
                {models
                  .filter((m) => m.available !== false || m.id === currentModelId)
                  // Hide embedding models — they aren't chat models (used internally for memory recall).
                  .filter((m) => !/embed/i.test(m.id) && !/embed/i.test(m.label))
                  // De-dupe the gateway default: the detected "spectre-default" is the SAME backing
                  // model as the catalog "LiteLLM gateway (default model)" entry.
                  .filter((m) => m.id !== "spectre-default")
                  .map((m) => {
                  const sel = m.id === currentModelId;
                  const unavailable = m.available === false;
                  return (
                    <button
                      key={m.id || "__auto"}
                      className={`model-dd-item${sel ? " sel" : ""}${unavailable ? " model-dd-item-unavail" : ""}`}
                      onClick={unavailable ? undefined : () => selectModel(m.id)}
                      disabled={unavailable}
                      role="option"
                      aria-selected={sel}
                      aria-disabled={unavailable}
                      title={unavailable ? (m.unavailableReason ?? "Unavailable") : undefined}
                    >
                      <Check size={15} strokeWidth={2.2} className={`model-dd-check${sel ? "" : " off"}`} />
                      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.label}
                      </span>
                      {unavailable && (
                        <span className="model-dd-unavail-badge">unavail</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {/* Per-thread reasoning effort selector */}
          {showEffortPicker && (
            <div className="chat-effort-row">
              <button
                type="button"
                className={`chat-effort-pill${currentReasoningEffort === "" ? " active" : ""}`}
                onClick={() => selectEffort("")}
                title="Model default effort"
              >
                auto
              </button>
              {currentModel.effortLevels!.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`chat-effort-pill${currentReasoningEffort === level ? " active" : ""}`}
                  onClick={() => selectEffort(level)}
                  title={`Reasoning effort: ${level}`}
                >
                  {level}
                </button>
              ))}
            </div>
          )}
        </header>

        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="chat-empty-orb">
                <Sparkles size={30} strokeWidth={1.5} />
              </div>
              <div className="chat-empty-title">At your service.</div>
              <div className="chat-empty-sub">What are we working on?</div>
            </div>
          ) : (
            <div className="messages-inner">
              {messages.map((m) => {
                const pos = queuePos.get(m.id);
                const dim = m.status === "queued" || isQueuedPromptUser(m, messages);
                return (
                  <MessageRow
                    key={m.id}
                    msg={m}
                    isRunning={m.status === "running"}
                    dim={dim}
                    queuePos={pos}
                  />
                );
              })}
            </div>
          )}
        </div>

        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 16px 10px", maxWidth: "44rem", margin: "0 auto", width: "100%" }}>
            {pending.map((p) => (
              <div
                key={p.reqId}
                style={{
                  border: "1px solid var(--accent-deep)",
                  background: "rgba(99,102,241,0.08)",
                  borderRadius: 14,
                  padding: "12px 14px",
                  boxShadow: "var(--glow-sm)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13 }}>
                  <ShieldAlert size={14} strokeWidth={1.7} color="var(--accent-bright)" />
                  <span>
                    Approve <b>{p.tool.replace(/^mcp__spectre__/, "")}</b>?
                  </span>
                </div>
                {p.input != null && (
                  <pre
                    style={{
                      margin: "8px 0 0",
                      padding: "8px 10px",
                      maxHeight: 140,
                      overflow: "auto",
                      background: "var(--color-bg)",
                      border: "1px solid var(--ink-faint)",
                      borderRadius: 8,
                      fontSize: 11.5,
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {(typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2)).slice(0, 600)}
                  </pre>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn tap-press" onClick={() => decide(p.reqId, "allow")}>
                    Approve
                  </button>
                  <button className="btn ghost tap-press" onClick={() => decide(p.reqId, "allow_session")}>
                    Allow session
                  </button>
                  <button className="btn danger tap-press" onClick={() => decide(p.reqId, "deny")}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {(attached.length > 0 || showPicker) && (
          <div style={{ padding: "0 16px 8px", display: "flex", flexDirection: "column", gap: 8, maxWidth: "44rem", margin: "0 auto", width: "100%" }}>
            {attached.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-muted)" }}>
                  reading
                </span>
                {attached.map((id) => (
                  <span
                    key={id}
                    className="mono"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      padding: "3px 6px 3px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--accent-deep)",
                      background: "rgba(99,102,241,0.10)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    <FileText size={11} strokeWidth={1.7} />
                    <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{docLabel(id)}</span>
                    <button
                      onClick={() => toggleAttach(id)}
                      title="Detach"
                      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, display: "flex" }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {showPicker && (
              <div
                style={{
                  border: "1px solid var(--ink-faint)",
                  background: "var(--color-bg)",
                  borderRadius: 14,
                  padding: 8,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {pdfs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", padding: "8px 6px" }}>
                    No ready documents. Upload a PDF in the <b>Library</b> tab, then attach it here.
                  </div>
                ) : (
                  pdfs.map((p) => {
                    const on = attached.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => toggleAttach(p.id)}
                        className="tap-press"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 9,
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 9px",
                          borderRadius: 8,
                          border: "1px solid transparent",
                          background: on ? "rgba(99,102,241,0.12)" : "transparent",
                          color: "var(--color-text)",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        <FileText size={15} strokeWidth={1.6} style={{ opacity: 0.7, flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.title?.trim() || p.filename}
                        </span>
                        <span
                          aria-hidden
                          style={{
                            flexShrink: 0,
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            display: "grid",
                            placeItems: "center",
                            border: `1px solid ${on ? "var(--accent-bright)" : "var(--ink-faint)"}`,
                            background: on ? "var(--accent-bright)" : "transparent",
                            color: "var(--color-bg)",
                            fontSize: 11,
                          }}
                        >
                          {on ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {running && (
          <div className="stop-float">
            <button onClick={stop} title="Stop generating">
              <Square size={13} strokeWidth={2} fill="currentColor" /> Stop generating
            </button>
          </div>
        )}

        <div className="composer-dock">
          <div className="composer">
            <button
              className="composer-attach"
              onClick={() => {
                setShowPicker((s) => !s);
                if (!showPicker) loadPdfs();
              }}
              title="Attach a PDF to ground answers"
            >
              <Paperclip size={18} strokeWidth={1.7} />
              {attached.length > 0 && <span className="mono" style={{ fontSize: 11 }}>{attached.length}</span>}
            </button>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder="Message Spectre…"
              aria-label="Message Spectre"
              rows={1}
            />
            <button
              className={`composer-send${input.trim() ? "" : " idle"}`}
              onClick={send}
              title="Send message"
              aria-label="Send message"
            >
              <ArrowUp size={20} strokeWidth={2.4} />
              {queueCount >= 1 && <span className="composer-send-badge">·{queueCount}</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A user message is "the prompt that's waiting" when the assistant turn that
 * immediately follows it (next row by created_at) is still queued. We dim it
 * alongside that queued slot.
 */
function isQueuedPromptUser(m: Msg, all: Msg[]): boolean {
  if (m.role !== "user") return false;
  const i = all.findIndex((x) => x.id === m.id);
  const next = all[i + 1];
  return !!next && next.role === "assistant" && next.status === "queued";
}

function MessageRow({
  msg,
  isRunning,
  dim,
  queuePos,
}: {
  msg: Msg;
  isRunning: boolean;
  dim: boolean;
  queuePos?: number;
}) {
  if (msg.role === "user") {
    return (
      <div className={`bubble-wrap user${dim ? " dim" : ""}`}>
        <div className="bubble user">{msg.content}</div>
      </div>
    );
  }

  const parts = msg.tool_calls ?? [];
  const hasParts = parts.length > 0;
  const text = msg.content ?? "";
  const thinking = isRunning && !text.length && !hasParts;

  return (
    <div className={`bubble-wrap assistant${dim ? " dim" : ""}`}>
      <div className={`bubble assistant${isRunning ? " running" : ""}`}>
        {thinking ? (
          <Thinking />
        ) : hasParts ? (
          <Interleaved parts={parts} content={text} isRunning={isRunning} />
        ) : (
          <>
            <ChatMarkdown content={text} />
            {isRunning && text.length > 0 && <span className="caret animate-blink" aria-hidden />}
          </>
        )}
      </div>

      {msg.status === "queued" && queuePos != null && (
        <span className="queue-pill">⏳ Queued · {ordinal(queuePos)}</span>
      )}
      {msg.status === "cancelled" && (
        <span className="bubble-badge">
          <Square size={9} strokeWidth={2} fill="currentColor" /> Stopped
        </span>
      )}
      {msg.status === "error" && (
        <span className="bubble-badge err">Run failed</span>
      )}
    </div>
  );
}

function ordinal(pos: number): string {
  if (pos === 1) return "next up";
  if (pos === 2) return "2nd";
  if (pos === 3) return "3rd";
  return `${pos}th`;
}

function Interleaved({
  parts,
  content,
  isRunning,
}: {
  parts: Part[];
  content: string;
  isRunning: boolean;
}) {
  const results = new Map<string, Extract<Part, { type: "tool_result" }>>();
  for (const p of parts) if (p.type === "tool_result") results.set(p.toolUseId, p);

  const nodes: React.ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.type === "text") {
      if (p.text.trim()) nodes.push(<ChatMarkdown key={`t${i}`} content={p.text} />);
    } else if (p.type === "tool_use") {
      nodes.push(<ToolChip key={p.id || `u${i}`} call={p} result={results.get(p.id)} />);
    }
  });

  const hasTextPart = parts.some((p) => p.type === "text" && p.text.trim().length > 0);
  if (content.trim() && !hasTextPart) {
    nodes.push(<ChatMarkdown key="tail" content={content} />);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {nodes}
      {isRunning && <span className="caret animate-blink" aria-hidden />}
    </div>
  );
}

function ToolChip({
  call,
  result,
}: {
  call: Extract<Part, { type: "tool_use" }>;
  result?: Extract<Part, { type: "tool_result" }>;
}) {
  const [open, setOpen] = useState(false);
  const done = result != null;
  const isError = result?.isError === true;
  const name = call.name.replace(/^mcp__spectre__/, "");
  const imgUrl = done ? extractImageUrl(result!.output) : null;

  return (
    <div className={`toolchip${isError ? " err" : ""}`}>
      <button className="toolchip-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        {done ? (
          <Wrench size={12} strokeWidth={2} style={{ color: isError ? "var(--color-error)" : "var(--color-accent-hover)" }} />
        ) : (
          <span className="toolchip-spin" aria-hidden />
        )}
        <span className="toolchip-name">{name}</span>
      </button>
      {open && (
        <div className="toolchip-body">
          <div>
            <div className="toolchip-sec-label">Input</div>
            <pre className="toolchip-pre">{stringify(call.input)}</pre>
          </div>
          {done && (
            <div>
              <div className="toolchip-sec-label">Output</div>
              <pre className="toolchip-pre">{stringify(result!.output)}</pre>
            </div>
          )}
          {imgUrl && <img className="toolchip-img" src={imgUrl} alt="tool result" />}
        </div>
      )}
    </div>
  );
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function extractImageUrl(output: unknown): string | null {
  if (typeof output === "string") {
    return /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i.test(output.trim()) ? output.trim() : null;
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const key of ["url", "image_url", "imageUrl", "image"]) {
      const v = o[key];
      if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    }
  }
  return null;
}

function Thinking() {
  const [verb, setVerb] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setVerb((v) => (v + 1) % THINKING_VERBS.length), 2000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="thinking">
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-verb">{THINKING_VERBS[verb]}</span>
    </div>
  );
}
