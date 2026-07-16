"use client";

/**
 * One thread's conversation — the message stream + composer, lifted out of the
 * Chats page so it can be embedded anywhere (the Workspaces chat panel uses it).
 * It is CONTROLLED by `threadId`: the parent owns thread creation/selection and
 * passes the id in. On first send with no thread, it asks the parent to mint one
 * via `onEnsureThread` (so the parent can stamp the right metadata, e.g. a
 * workspace slot binding) and enqueues against the returned id.
 *
 * Streaming, rendering, scroll-stick, and the HITL approval gate mirror the
 * Chats tab exactly (shared `MessageRow`, shared `chat.css`).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "../../app/chat/chat.css";
import { ArrowUp, Square, ShieldAlert } from "lucide-react";
import { MessageRow, isQueuedPromptUser, type Msg } from "@/components/chat/MessageRow";
import { subscribeThreadStream } from "@/lib/thread-stream";

type PendingReq = { reqId: string; threadId: string; tool: string; input?: unknown; createdAt: number };

export function ThreadChat({
  threadId,
  onEnsureThread,
  placeholder = "Message Spectre…",
  emptyTitle = "At your service.",
  emptySub = "What are we working on?",
}: {
  threadId: string | null;
  /** Mint a thread on first send (parent stamps metadata + selects it). */
  onEnsureThread: () => Promise<string | null>;
  placeholder?: string;
  emptyTitle?: string;
  emptySub?: string;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingReq[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);

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

  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput("");
    atBottomRef.current = true;
    const tid = threadId ?? (await onEnsureThread());
    if (!tid) return;
    await fetch(`/api/threads/${tid}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  }

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

  return (
    <div className="threadchat">
      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">{emptyTitle}</div>
            <div className="chat-empty-sub">{emptySub}</div>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 12px 10px", width: "100%" }}>
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
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
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

      {running && (
        <div className="stop-float">
          <button onClick={stop} title="Stop generating">
            <Square size={13} strokeWidth={2} fill="currentColor" /> Stop generating
          </button>
        </div>
      )}

      <div className="composer-dock">
        <div className="composer">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder={placeholder}
            aria-label={placeholder}
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
  );
}
