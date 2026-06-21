"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { onAsk, type AskRequest } from "@/lib/module-open";

/**
 * Global "open in this window or a new one?" prompt for the ASK tab-open mode.
 * Mounted once in the root layout so it overlays every tab. Subscribes to the
 * module-open pub/sub; renders nothing until a request comes in.
 */
export function ModuleOpenPrompt() {
  const [req, setReq] = useState<AskRequest | null>(null);
  const [remember, setRemember] = useState(false);

  useEffect(
    () =>
      onAsk((r) => {
        setRemember(false);
        setReq(r);
      }),
    [],
  );

  if (!req) return null;

  const choose = (mode: "same" | "new" | null) => {
    req.decide(mode, remember);
    setReq(null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Open ${req.moduleId}`}
      style={overlay}
      onClick={(e) => e.target === e.currentTarget && choose(null)}
      onKeyDown={(e) => e.key === "Escape" && choose(null)}
    >
      <div style={card}>
        <div style={title}>
          Open <span style={{ color: "var(--color-accent-hover)" }}>{req.moduleId}</span>
        </div>
        <div style={row}>
          <button type="button" style={btn} className="tap-press" onClick={() => choose("same")}>
            This window
          </button>
          <button type="button" style={btn} className="tap-press" onClick={() => choose("new")}>
            New window
          </button>
        </div>
        <label style={rememberRow}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            aria-label={`Remember for ${req.moduleId}`}
          />
          Remember for <span className="mono">{req.moduleId}</span>
        </label>
        <button type="button" style={cancel} onClick={() => choose(null)}>
          cancel
        </button>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(5,5,7,0.55)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
};
const card: CSSProperties = {
  minWidth: 280,
  padding: "20px 22px",
  borderRadius: "var(--r-lg, 14px)",
  background: "var(--color-surface, rgba(15,18,30,0.9))",
  border: "1px solid var(--color-border, rgba(126,237,255,0.25))",
  boxShadow: "0 20px 60px rgba(0,0,0,0.6), var(--glow-sm)",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const title: CSSProperties = { fontFamily: "var(--font-outfit)", fontSize: 18, fontWeight: 600, color: "var(--color-text)" };
const row: CSSProperties = { display: "flex", gap: 10 };
const btn: CSSProperties = {
  flex: 1,
  padding: "11px 14px",
  borderRadius: "var(--r)",
  background: "rgba(99,102,241,0.12)",
  border: "1px solid var(--color-accent, rgba(126,237,255,0.4))",
  color: "var(--color-text)",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};
const rememberRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--color-text-secondary)",
  cursor: "pointer",
};
const cancel: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-text-muted)",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
  alignSelf: "center",
};
