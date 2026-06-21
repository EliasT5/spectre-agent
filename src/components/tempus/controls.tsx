"use client";

import type { CSSProperties, ReactNode } from "react";

export const fieldStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--r)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  font: "inherit",
  fontSize: 14,
  width: "100%",
};

export function Btn({
  variant = "ghost",
  disabled,
  onClick,
  children,
  title,
}: {
  variant?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}) {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    padding: "9px 14px",
    borderRadius: "var(--r)",
    font: "inherit",
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    border: "1px solid var(--color-border)",
    color: "var(--color-text)",
    background: "var(--color-surface)",
  };
  const v: CSSProperties =
    variant === "primary"
      ? { background: "rgba(99,102,241,0.16)", border: "1px solid var(--color-accent, rgba(126,237,255,0.4))", boxShadow: "var(--glow-sm)" }
      : variant === "danger"
        ? { background: "rgba(248,113,113,0.14)", border: "1px solid rgba(248,113,113,0.5)" }
        : {};
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick} className="tap-press" style={{ ...base, ...v }}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 4,
        borderRadius: "var(--pill, 999px)",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="tap-press"
          style={{
            padding: "6px 15px",
            borderRadius: "var(--pill, 999px)",
            border: "none",
            font: "inherit",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            color: value === o.value ? "var(--color-text)" : "var(--color-text-muted)",
            background: value === o.value ? "rgba(99,102,241,0.18)" : "transparent",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div style={{ padding: "10px 12px", borderRadius: "var(--r)", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.4)", color: "var(--color-danger, #f87171)", fontSize: 13 }}>
      {error}
    </div>
  );
}
