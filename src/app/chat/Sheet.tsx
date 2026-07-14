"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * Bottom action sheet — the shared chrome for the chat tab's category manager
 * and per-chat action menu. A backdrop + a glass panel that docks to the bottom
 * on phone widths and centers on desktop (see chat.css). Closes on Escape and on
 * a backdrop click. Kept presentational: the parent owns open/close state and
 * conditionally renders it.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dialog focus management: move focus into the panel on open (unless a child
  // already claimed it, e.g. an autoFocus'd input), trap Tab within it while
  // open (aria-modal), and restore focus to the opener (kebab / "+") on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null)
        : [];
    if (panel && !panel.contains(document.activeElement)) panel.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <div className="sheet-heading">
            <div className="sheet-title">{title}</div>
            {subtitle && <div className="sheet-sub">{subtitle}</div>}
          </div>
          <button className="sheet-close tap-press" onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={1.8} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
