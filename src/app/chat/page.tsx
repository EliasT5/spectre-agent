"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquare, Plus, Send, Square, ShieldAlert, Paperclip, FileText, X } from "lucide-react";
import { SpectreBackButton } from "@/components/SpectreBackButton";
import { Fab, Well } from "@/components/ui";
import { subscribeThreadStream } from "@/lib/thread-stream";

/**
 * Real chat: a thread list you can revisit + a durable, live-streamed
 * conversation. Enqueue through the core; watch the rows fill via the core's
 * SSE thread stream (survives disconnects — the run is runner+core+DB); Stop
 * cancels. Assistant text is markdown; tool_use parts render as subagent/tool
 * chips so the orchestration is visible. The browser never talks to storage:
 * everything rides /api/* through the PIN-gated proxy.
 */

type Part =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  status: string | null;
  tool_calls: Part[] | null;
  created_at: string;
};

type ThreadMeta = { pdf_ids?: string[]; kind?: string };
type Thread = { id: string; title: string | null; created_at: string; archived?: boolean; metadata?: ThreadMeta };
type PendingReq = { reqId: string; threadId: string; tool: string; input?: unknown; createdAt: number };
type PdfDoc = { id: string; filename: string; title: string | null; status: string };

const ACTIVE = new Set(["queued", "running"]);

export default function ChatTab() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingReq[]>([]);
  const [pdfs, setPdfs] = useState<PdfDoc[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = async () => {
    const r = await fetch("/api/threads");
    if (r.ok) {
      const data = await r.json();
      const arr: Thread[] = Array.isArray(data) ? data : data.threads ?? [];
      setThreads(arr.filter((t) => !t.archived));
    }
  };
  useEffect(() => {
    loadThreads();
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
  // The broker blocks a gated tool until a human decides; we surface a card.
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const active = messages.find((m) => m.role === "assistant" && ACTIVE.has(m.status ?? ""));
  const busy = !!active;

  async function newChat() {
    setMessages([]);
    setThreadId(null);
  }

  async function ensureThread(seedTitle?: string): Promise<string | null> {
    if (threadId) return threadId;
    const r = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: seedTitle?.slice(0, 60) || "New chat" }),
    });
    if (!r.ok) return null;
    const tid = (await r.json()).id;
    setThreadId(tid);
    loadThreads();
    return tid;
  }

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    setInput("");
    const tid = await ensureThread(content);
    if (!tid) return;
    await fetch(`/api/threads/${tid}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

  // Attach/detach a PDF on the current thread; the run loop reads metadata.pdf_ids
  // each turn, so this is all it takes to ground answers in the document.
  async function toggleAttach(id: string) {
    const tid = await ensureThread();
    if (!tid) return;
    const next = attached.includes(id) ? attached.filter((x) => x !== id) : [...attached, id];
    setAttached(next); // optimistic
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
    if (!threadId || !active) return;
    await fetch(`/api/threads/${threadId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: active.id }),
    });
  }

  async function decide(reqId: string, decision: "allow" | "deny" | "allow_session") {
    if (!threadId) return;
    setPending((prev) => prev.filter((p) => p.reqId !== reqId)); // optimistic
    await fetch(`/api/threads/${threadId}/permission/${reqId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => {});
  }

  return (
    <div className="chat-layout">
      <SpectreBackButton />
      <aside className="threads">
        <span
          className="eyebrow"
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 4px 2px" }}
        >
          <MessageSquare size={11} strokeWidth={1.6} /> Threads
        </span>
        <button className="newchat" onClick={newChat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Plus size={14} strokeWidth={1.6} /> New chat
        </button>
        <div className="thread-list">
          {threads.map((t) => {
            const isActive = t.id === threadId;
            return (
              <button
                key={t.id}
                className={`thread-item${isActive ? " active" : ""}`}
                onClick={() => setThreadId(t.id)}
                title={t.title ?? "Untitled"}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: isActive ? "var(--color-accent-hover)" : "var(--ink-faint)",
                    boxShadow: isActive ? "0 0 8px var(--glow-primary)" : "none",
                  }}
                />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title?.trim() || "New chat"}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="chat-main">
        <div className="messages" ref={scrollRef}>
          {messages.length === 0 && (
            <div
              className="empty"
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                textAlign: "center",
              }}
            >
              <Well lg>
                <MessageSquare size={22} strokeWidth={1.6} />
              </Well>
              <span style={{ color: "var(--color-text-secondary)", fontSize: 14.5 }}>
                Say something to Spectre.
              </span>
            </div>
          )}
          {messages.map((m) => {
            const chips = (m.tool_calls ?? []).filter((p): p is Extract<Part, { type: "tool_use" }> => p.type === "tool_use");
            const pending = m.role === "assistant" && ACTIVE.has(m.status ?? "") && !(m.content ?? "").length && chips.length === 0;
            return (
              <div key={m.id} className={`bubble ${m.role}${pending ? " pending" : ""}`}>
                {chips.length > 0 && (
                  <div className="chips">
                    {chips.map((c) => (
                      <span key={c.id} className="chip">{c.name.replace(/^mcp__spectre__/, "")}</span>
                    ))}
                  </div>
                )}
                {m.role === "assistant" ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content ?? ""}</ReactMarkdown>
                  </div>
                ) : (
                  m.content
                )}
                {m.status === "cancelled" && (
                  <span
                    className="mono"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      marginTop: 6,
                      fontSize: 10.5,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    <Square size={9} strokeWidth={1.6} /> stopped
                  </span>
                )}
                {m.status === "error" && !m.content && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--color-error)",
                    }}
                  >
                    run failed
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 16px 10px" }}>
            {pending.map((p) => (
              <div
                key={p.reqId}
                style={{
                  border: "1px solid var(--accent-deep)",
                  background: "rgba(99,102,241,0.08)",
                  borderRadius: 12,
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
          <div style={{ padding: "0 16px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
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
                  borderRadius: 12,
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

        <div className="composer">
          <button
            className="btn ghost tap-press"
            onClick={() => {
              setShowPicker((s) => !s);
              if (!showPicker) loadPdfs();
            }}
            title="Attach a PDF to ground answers"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, position: "relative" }}
          >
            <Paperclip size={16} strokeWidth={1.6} />
            {attached.length > 0 && <span className="mono" style={{ fontSize: 11 }}>{attached.length}</span>}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Message Spectre…"
            aria-label="Message Spectre"
          />
          {busy ? (
            <button className="btn danger tap-press" onClick={stop} title="Stop generation">
              <Square size={14} strokeWidth={1.6} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              Stop
            </button>
          ) : (
            <Fab
              onClick={send}
              disabled={!input.trim()}
              title="Send message"
              // Inline beats the `.composer button` rule that would otherwise
              // flatten .fab into a rounded rectangle (kill its round + gradient).
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                padding: 0,
                background: "linear-gradient(135deg, var(--grad-start), var(--grad-mid))",
                boxShadow: "var(--glow-sm)",
              }}
            >
              <Send size={17} strokeWidth={1.6} />
            </Fab>
          )}
        </div>
      </main>
    </div>
  );
}
