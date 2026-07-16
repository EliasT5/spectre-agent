"use client";

/**
 * Shared conversation-rendering primitives, lifted out of the Chats page so the
 * full Chats tab and the embedded Workspaces chat panel render messages
 * identically (one source of truth — they must never diverge). Everything here
 * is presentational: it takes `Msg`/`Part` props and touches no page state.
 */

import { useEffect, useState } from "react";
import { Square, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

export type Msg = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  status: string | null;
  tool_calls: Part[] | null;
  created_at: string;
};

const THINKING_VERBS = ["thinking…", "reasoning…", "working…", "reading…"];

/**
 * A user message is "the prompt that's waiting" when the assistant turn that
 * immediately follows it (next row by created_at) is still queued. We dim it
 * alongside that queued slot.
 */
export function isQueuedPromptUser(m: Msg, all: Msg[]): boolean {
  if (m.role !== "user") return false;
  const i = all.findIndex((x) => x.id === m.id);
  const next = all[i + 1];
  return !!next && next.role === "assistant" && next.status === "queued";
}

export function MessageRow({
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
