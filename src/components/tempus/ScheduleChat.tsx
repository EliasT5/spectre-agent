"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Send, Square, Sparkles } from "lucide-react";
import { Btn, fieldStyle } from "./controls";
import { subscribeThreadStream } from "@/lib/thread-stream";

/**
 * Describe a schedule in plain language; Spectre creates it. This is a real
 * durable-chat thread to the brain (reusing /api/threads + the core's SSE
 * thread stream, same as the Chat tab), so the brain uses its
 * schedule.create/update tools. A hidden directive frames each message as a
 * scheduling request; the user only ever types what they want. When a run
 * finishes, the schedules list refreshes.
 */

type ToolUse = { type: "tool_use"; id: string; name: string };
type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  status: string | null;
  tool_calls: Array<{ type: string; id?: string; name?: string }> | null;
  created_at: string;
};

const ACTIVE = new Set(["queued", "running"]);
const LS = "spectre.tempusSchedThread";
const DIRECTIVE =
  "You are Spectre's scheduling assistant. Create or adjust a DURABLE SPECTRE schedule for the request below by CALLING the Spectre MCP tool `mcp__spectre__schedule_create` (or schedule_update / schedule_list / schedule_delete). Do NOT create a Claude Code routine, a claude.ai routine, or any other background task — those are NOT Spectre schedules and will not work here; the ONLY valid path is the mcp__spectre__schedule_* tools. After the tool returns, confirm in ONE short line: the schedule name, when it runs, whether it replies in chat / notifies / both, and its id. Request:\n\n";

function stripDirective(s: string | null): string {
  if (!s) return "";
  return s.startsWith(DIRECTIVE) ? s.slice(DIRECTIVE.length) : s;
}

export function ScheduleChat({ onChange }: { onChange: () => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = localStorage.getItem(LS);
    if (id) setThreadId(id);
  }, []);

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
      onRow: (row) => {
        upsert(row);
        // A finished assistant turn may have created/changed a schedule.
        if (row.role === "assistant" && row.status && !ACTIVE.has(row.status)) onChange();
      },
    });
  }, [threadId, onChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const active = messages.find((m) => m.role === "assistant" && ACTIVE.has(m.status ?? ""));
  const busy = !!active;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    let tid = threadId;
    if (!tid) {
      const r = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tempus · scheduling" }),
      });
      if (!r.ok) return;
      tid = (await r.json()).id as string;
      setThreadId(tid);
      localStorage.setItem(LS, tid);
    }
    await fetch(`/api/threads/${tid}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: DIRECTIVE + text }),
    });
  }

  async function stop() {
    if (!threadId || !active) return;
    await fetch(`/api/threads/${threadId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: active.id }),
    });
  }

  function reset() {
    setThreadId(null);
    setMessages([]);
    localStorage.removeItem(LS);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div ref={scrollRef} style={feed}>
        {messages.length === 0 ? (
          <div style={{ color: "var(--color-text-muted)", fontSize: 13, lineHeight: 1.6, padding: "8px 4px" }}>
            <Sparkles size={14} style={{ verticalAlign: "-2px" }} /> Describe what Spectre should do and when — e.g.{" "}
            <em>&ldquo;every morning at 8, summarize my unread emails and notify me&rdquo;</em> or{" "}
            <em>&ldquo;every Friday 5pm, draft a weekly review in chat&rdquo;</em>. Spectre sets up the schedule for you.
          </div>
        ) : (
          messages.map((m) => {
            const chips = (m.tool_calls ?? []).filter((p): p is ToolUse => p.type === "tool_use");
            const pending = m.role === "assistant" && ACTIVE.has(m.status ?? "") && !(m.content ?? "").length && chips.length === 0;
            return (
              <div key={m.id} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
                {chips.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 4 }}>
                    {chips.map((c) => (
                      <span key={c.id} className="mono" style={chip}>{(c.name || "").replace(/^mcp__spectre__/, "")}</span>
                    ))}
                  </div>
                )}
                <div style={m.role === "user" ? userBubble : asstBubble}>
                  {m.role === "user" ? stripDirective(m.content) : pending ? <Working /> : (m.content ?? (m.status === "error" ? "run failed" : ""))}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Describe a schedule for Spectre…"
          aria-label="Describe a schedule"
          style={{ ...fieldStyle, flex: 1 }}
        />
        {busy ? (
          <Btn variant="danger" onClick={stop}><Square size={14} /> Stop</Btn>
        ) : (
          <Btn variant="primary" disabled={!input.trim()} onClick={send}><Send size={14} /> Send</Btn>
        )}
      </div>
      {messages.length > 0 && (
        <button type="button" onClick={reset} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--color-text-muted)", font: "inherit", fontSize: 12, cursor: "pointer" }}>
          new conversation
        </button>
      )}
    </div>
  );
}

function Working() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x + 1) % 4), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="mono" style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
      Spectre is working{".".repeat(n)}
      <span style={{ opacity: 0 }}>{".".repeat(3 - n)}</span>
    </span>
  );
}

const feed: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxHeight: 320,
  overflowY: "auto",
  padding: 4,
};
const userBubble: CSSProperties = {
  padding: "9px 13px",
  borderRadius: "14px 14px 4px 14px",
  background: "rgba(99,102,241,0.18)",
  border: "1px solid var(--color-accent, rgba(126,237,255,0.35))",
  fontSize: 14,
  lineHeight: 1.5,
};
const asstBubble: CSSProperties = {
  padding: "9px 13px",
  borderRadius: "14px 14px 14px 4px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  fontSize: 14,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};
const chip: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: ".04em",
  padding: "2px 7px",
  borderRadius: 99,
  background: "rgba(99,102,241,0.14)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-secondary)",
};
