"use client";

import { Children, useEffect, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { SpectreBackButton } from "@/components/SpectreBackButton";

// One orchestrated page-load reveal (Anthropic's frontend-aesthetics rule:
// prefer a single staggered reveal over scattered micro-interactions). Transform
// + opacity only, ease-out — Emil Kowalski's craft for motion that feels native.
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
const revealContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.06 } },
};
const revealItem = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } },
};

/**
 * @spectre/ui — the shared instrument kit ("Glass HUD console").
 *
 * Every tab and module composes these so the whole shell reads as one
 * instrument: frosted glass panels over the indigo void, HUD corner-brackets,
 * gradient-borders that breathe on hover, mono telemetry, gradient-text numbers.
 * The look lives in globals.css; these are the typed building blocks. A module
 * author assembles TabShell + Panel + Row/Stat/Chip/StatusDot/Bar, or describes
 * a read-mostly tab as data and hands it to <SchemaTab>. Keep this kit +
 * globals.css in lockstep: together they ARE the UI schema.
 */

export type Tone = "ok" | "warn" | "crit" | "off";

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** The HUD chrome behind a tab: Spectre mark + eyebrow + gradient title + live status. */
export function TabShell({
  title,
  eyebrow,
  status,
  tone = "ok",
  back = true,
  children,
}: {
  title: string;
  eyebrow?: ReactNode;
  status?: ReactNode;
  tone?: Tone;
  back?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="tab">
      {back && <SpectreBackButton />}
      <motion.header
        className="tabhead"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT }}
      >
        <div className="tabhead-titles">
          {eyebrow != null && <span className="eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
        </div>
        {status != null && (
          <span className="statusline">
            <StatusDot tone={tone} />
            {status}
          </span>
        )}
      </motion.header>
      <div className="hairline-gradient tabhead-rule" />
      <motion.div className="tabbody" variants={revealContainer} initial="hidden" animate="show">
        {Children.toArray(children).map((child, i) => (
          <motion.div key={i} variants={revealItem}>
            {child}
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}

/**
 * A glass instrument panel. Pass `icon` + `title` for the HUD panel-head
 * (icon-well + eyebrow + display title + optional `aside`); or just `label`
 * (+ optional `meta`) for the lighter mono-caption form. `hud` adds corner
 * brackets, `live` adds the rotating "streaming" border.
 */
export function Panel({
  label,
  title,
  icon,
  meta,
  aside,
  hud,
  live,
  children,
  style,
}: {
  label?: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  hud?: boolean;
  live?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const head = icon != null || title != null;
  return (
    <motion.div
      className={cx("panel", "gradient-border", hud && "hud", live && "animated-border")}
      style={style}
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
    >
      <div className="glass-fresnel" aria-hidden />
      {head ? (
        <div className="panel-head">
          {icon != null && <span className="well">{icon}</span>}
          <div className="titles">
            {label != null && <span className="eyebrow">{label}</span>}
            {title != null && <h2>{title}</h2>}
          </div>
          {aside != null && <span className="aside">{aside}</span>}
        </div>
      ) : (
        (label != null || meta != null) && (
          <div className="card-meta">
            {label != null && <span className="label">{label}</span>}
            {meta}
          </div>
        )
      )}
      {children}
    </motion.div>
  );
}

/** A label/value row; stack several inside a Panel for a readout. */
export function Row({ label, children, onClick }: { label: ReactNode; children: ReactNode; onClick?: () => void }) {
  return (
    <div
      className="row"
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className="label">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
/** A stat tile — big gradient-text number over a mono label. */
export function Stat({ n, k }: { n: ReactNode; k: ReactNode }) {
  return (
    <div className="stat">
      <span className="n">{n}</span>
      <span className="k">{k}</span>
    </div>
  );
}

/**
 * An animated count-up number for telemetry. Springs from 0 → value (and
 * re-animates when value changes). Self-styles its text — gradient by default,
 * or a solid `color` for a toned reading — because it sits inside `.stat .n`
 * whose gradient text-clip would otherwise render a nested span invisible.
 */
export function Counter({ value, color }: { value: number; color?: string }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => Math.round(v).toString());
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease: EASE_OUT });
    return () => controls.stop();
  }, [value, mv]);
  const style: CSSProperties = color
    ? { color, WebkitTextFillColor: color }
    : {
        background: "linear-gradient(135deg, var(--grad-start), var(--grad-mid), var(--grad-end))",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
        color: "transparent",
      };
  return <motion.span style={style}>{text}</motion.span>;
}

/** A live status dot with a pinging halo. */
export function StatusDot({ tone = "ok" }: { tone?: Tone }) {
  return <span className={cx("status-dot", tone !== "ok" && tone)} aria-hidden />;
}

/** A thin gradient progress / weight bar; `value` is 0..1. */
export function Bar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="bar">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Segmented control — a row of mono pills, one lit. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={cx(value === o.value && "on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A stateful on/off pill toggle (not a slider). */
export function Toggle({ on, onClick, children }: { on?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button className={cx("toggle", on && "on")} onClick={onClick} aria-pressed={!!on}>
      {children}
    </button>
  );
}

/** An accent-tinted icon well (holds a lucide icon). */
export function Well({ children, lg }: { children: ReactNode; lg?: boolean }) {
  return <span className={cx("well", lg && "lg")}>{children}</span>;
}

/** Round gradient action button (add / send). `style` escapes container CSS
 *  (e.g. the `.composer button` rule that would otherwise out-specify `.fab`). */
export function Fab({
  children,
  onClick,
  disabled,
  title,
  type = "button",
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  style?: CSSProperties;
}) {
  return (
    <button type={type} className="fab" onClick={onClick} disabled={disabled} title={title} aria-label={title} style={style}>
      {children}
    </button>
  );
}

/** A glass list row — the feed/list item. `head` is the top line, `when` the right-aligned timestamp. */
export function ListRow({
  head,
  when,
  onClick,
  children,
}: {
  head?: ReactNode;
  when?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={cx("list-row", onClick && "tap-press")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={onClick ? { cursor: "pointer" } : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {(head != null || when != null) && (
        <div className="row-head">
          {head}
          {when != null && <span className="when">{when}</span>}
        </div>
      )}
      {children != null && <div className="row-body">{children}</div>}
    </div>
  );
}

/** A mono pill. `on` lights it up; `color` overrides the accent (e.g. severity). */
export function Chip({
  children,
  on,
  color,
  onClick,
  title,
}: {
  children: ReactNode;
  on?: boolean;
  color?: string;
  onClick?: () => void;
  title?: string;
}) {
  const style = color ? ({ color, borderColor: color } as CSSProperties) : undefined;
  return (
    <span
      className={cx("tag", on && "on")}
      style={style}
      onClick={onClick}
      title={title}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function Toolbar({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", gap: 10, alignItems: "center", ...style }}>{children}</div>;
}

type ButtonVariant = "primary" | "ghost" | "danger";
export function Button({
  children,
  variant = "primary",
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={cx("btn", "tap-press", variant === "ghost" && "ghost", variant === "danger" && "danger")}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("input", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("select", props.className)} />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/** A shimmering placeholder block (reuses the existing `.skeleton` class). */
export function Skeleton({ height = 54, style }: { height?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ height, ...style }} aria-hidden />;
}

/** A danger-tinted sibling of EmptyState — for a failed source/action/widget. */
export function ErrorState({ children }: { children: ReactNode }) {
  return <div className="empty-state error-state">{children}</div>;
}

/**
 * A mono telemetry table. `columns` defines the header + cell order; `rows`
 * is a list of `key -> cell` maps. Sets `--cols` inline so the CSS grid tracks
 * follow the column count. Shows `empty` when there are no rows.
 */
export function Table({
  columns,
  rows,
  empty = "No rows.",
}: {
  columns: { key: string; label: ReactNode }[];
  rows: Record<string, ReactNode>[];
  empty?: ReactNode;
}) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="ktable" style={{ ["--cols" as string]: columns.length }}>
      <div className="ktable-head">
        {columns.map((c) => (
          <span key={c.key} className="label">
            {c.label}
          </span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={i} className="ktable-row">
          {columns.map((c) => (
            <span key={c.key} className="v">
              {r[c.key]}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

const SPARK_STROKE: Record<Tone, string> = {
  ok: "var(--accent-bright)",
  warn: "var(--color-warn)",
  crit: "var(--color-error)",
  off: "var(--color-text-muted)",
};

/**
 * An inline-SVG sparkline. Normalizes `values` into a polyline over a fixed
 * viewBox; tone picks the stroke from tokens. A flat/empty series renders a
 * centered baseline rather than collapsing.
 */
export function Sparkline({
  values,
  tone = "ok",
  width = 240,
  height = 40,
}: {
  values: number[];
  tone?: Tone;
  width?: number;
  height?: number;
}) {
  const pad = 3;
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  const min = n ? Math.min(...finite) : 0;
  const max = n ? Math.max(...finite) : 1;
  const span = max - min || 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const points =
    n === 0
      ? `${pad},${pad + innerH / 2} ${pad + innerW},${pad + innerH / 2}`
      : finite
          .map((v, i) => {
            const x = pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
            const y = pad + innerH - ((v - min) / span) * innerH;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke={SPARK_STROKE[tone]} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
