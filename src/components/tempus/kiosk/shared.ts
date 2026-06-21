import type { CSSProperties } from "react";

/**
 * Small shared helpers for the kiosk Tempus views (Dashboard / Projects /
 * Entries / Detail). Date <-> <input type="datetime-local"> conversion and a
 * couple of inline styles the @/components/ui kit doesn't cover (icon-only
 * action buttons, color swatch input).
 */

/** ISO string → the local "YYYY-MM-DDTHH:mm" a datetime-local input wants. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A local datetime-local value → ISO (UTC) for the API. "" → null. */
export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const t = Date.parse(local);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

export const iconBtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-text-muted)",
  cursor: "pointer",
  padding: 5,
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 8,
};

export const colorSwatch: CSSProperties = {
  width: 44,
  height: 40,
  borderRadius: "var(--r, 12px)",
  border: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  cursor: "pointer",
  flexShrink: 0,
  padding: 2,
};
