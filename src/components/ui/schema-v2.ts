/**
 * UI Schema v2 — a module's UI shipped AS DATA.
 *
 * A Data-mode module carries a `UISchemaV2` document in its manifest
 * (`ui.schema`). The host renders it on the shared kit via <SchemaRuntime>, so
 * the module looks like a built-in with ZERO module React. This file is the
 * PURE half: closed types + pure helpers only. No React, no "use client", no
 * `eval`, no Function constructor — the runtime (SchemaRuntime.tsx) owns the
 * imperative side and the closed SDK dispatch table.
 *
 * Trust model: a schema can only reference a data source / action by NAME from a
 * closed vocabulary. It never carries code. `resolvePath`/`resolveTemplate`
 * read values out of a scope by dotted path; they never execute anything.
 *
 * `Tone` is imported from the kit (the single source of truth) and re-exported
 * here so schema authors get it without reaching into kit.tsx — but note the
 * barrel (index.ts) already re-exports kit's Tone, so this file must be the only
 * other place it appears and they must be the SAME symbol (a type re-export, not
 * a redefinition) to avoid a duplicate-export clash.
 */
import type { Tone } from "./kit";

export type { Tone };

// ── primitives ────────────────────────────────────────────────────────────

/** A displayed value: a literal, or a "{{ tpl }}" template resolved at render. */
export type Val = string | number | boolean | null;

/** A whole-widget visibility guard, evaluated against the render scope. */
export interface WhenClause {
  /** dotted path into scope (e.g. "state.range", "data.health.coreApiVersion") */
  path: string;
  /** comparison; default "truthy" when `eq`/`ne` are both absent */
  op?: "==" | "!=" | "truthy";
  /** the literal to compare against for "==" / "!=" */
  value?: Val;
}

// ── data sources ──────────────────────────────────────────────────────────

/** A read from the closed @spectre/sdk dispatch table. `call` is a dotted path
 *  (e.g. "monitor", "health", "usage") that must be BOTH in SchemaRuntime's
 *  SDK_CALLS table AND granted by permissions.sdk, or it is refused. */
export interface SdkSource {
  source: "sdk";
  /** dotted sdk path, e.g. "monitor" | "health" | "usage" | "models" */
  call: string;
  /** positional args passed to the sdk fn (literals or "{{tpl}}") */
  args?: Val[];
  /** re-fetch interval in ms; omitted = fetch once */
  pollMs?: number;
}

/** A read from the module's own backend. TYPE-ONLY in P2b: SchemaRuntime never
 *  fetches a module source, it shows a "deferred" notice. Wired in P2c. */
export interface ModuleSource {
  source: "module";
  /** module backend endpoint (relative) */
  endpoint: string;
  pollMs?: number;
}

export type DataSource = SdkSource | ModuleSource;

// ── actions ───────────────────────────────────────────────────────────────

/** Call an sdk fn (gated identically to SdkSource); optionally store its result
 *  into state under `assignTo`. */
export interface SdkStep {
  step: "sdk";
  call: string;
  args?: Val[];
  /** state key to receive the resolved result */
  assignTo?: string;
}
/** Re-run named data sources (or all when `names` is omitted). */
export interface RefetchStep {
  step: "refetch";
  /** data-source names to refetch; omit to refetch everything */
  names?: string[];
}
/** Shallow-merge values into state (templates resolved against current scope). */
export interface SetStateStep {
  step: "setState";
  patch: Record<string, Val>;
}
/** Client-side navigation via the router. */
export interface NavigateStep {
  step: "navigate";
  to: string;
}
/**
 * Call the module's OWN backend (self-scoped) at /api/m/<id><endpoint> through
 * the core capability shim. Wired in P2c.
 *   - `method` defaults to POST,
 *   - `body` is either an object (each value resolved as a template against the
 *     current scope) OR the shorthand "@form:k1,k2" which pulls those state keys
 *     into a flat object,
 *   - `assignTo` stores the JSON result into state under that key.
 */
export interface ModuleStep {
  step: "module";
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, Val> | string;
  assignTo?: string;
}

export type ActionStep =
  | SdkStep
  | RefetchStep
  | SetStateStep
  | NavigateStep
  | ModuleStep;

/** A named, ordered list of steps a widget can trigger by name. */
export interface ActionDef {
  steps: ActionStep[];
}

// ── widgets ───────────────────────────────────────────────────────────────

/** Fields every widget shares. `when` controls WHOLE-widget visibility. */
interface Base {
  /** show the widget only when this clause holds */
  when?: WhenClause;
}

export interface PanelWidget extends Base {
  kind: "panel";
  /** lucide icon name (resolved by the runtime's curated ICONS map) */
  icon?: string;
  label?: Val;
  title?: Val;
  aside?: Val;
  hud?: boolean;
  live?: boolean;
  /** label/value rows rendered as <Row> */
  rows?: { label: Val; value: Val }[];
  /** nested widgets rendered inside the panel body */
  body?: Widget[];
}

export interface StatsWidget extends Base {
  kind: "stats";
  label?: Val;
  hud?: boolean;
  stats: {
    /** the big number; `counter` animates it (value must resolve numeric) */
    n: Val;
    k: Val;
    counter?: boolean;
    /** solid color for the reading (else gradient) */
    color?: string;
  }[];
}

export interface ListWidget extends Base {
  kind: "list";
  label?: Val;
  empty?: Val;
  /** source-slot name whose `.data` array drives the rows (each row = `item`) */
  from: string;
  /** per-row visibility guard (evaluated with `item` in scope) */
  rowWhen?: WhenClause;
  /** top-line of each row (templates may reference `item.*`) */
  rowHead?: Val;
  /** right-aligned timestamp/meta of each row (maps to ListRow's `when` slot) */
  rowMeta?: Val;
  /** body text of each row */
  rowBody?: Val;
}

export interface MetricWidget extends Base {
  kind: "metric";
  n: Val;
  k: Val;
  counter?: boolean;
  color?: string;
}

export interface GaugeWidget extends Base {
  kind: "gauge";
  /** 0..1 fill (template may resolve numeric) */
  value: Val;
  label?: Val;
}

export interface SegmentedWidget extends Base {
  kind: "segmented";
  /** state key this control reads/writes (two-way) */
  bind: string;
  options: { value: string; label: Val }[];
}

export interface ToggleWidget extends Base {
  kind: "toggle";
  /** state key this toggle reads/writes */
  bind: string;
  label: Val;
}

export interface ChipWidget extends Base {
  kind: "chip";
  label: Val;
  on?: boolean;
  color?: string;
}

export interface FormWidget extends Base {
  kind: "form";
  fields: {
    /** state key the input writes to */
    bind: string;
    label: Val;
    placeholder?: Val;
    type?: "text" | "number";
  }[];
}

export interface ActionRowWidget extends Base {
  kind: "actionRow";
  buttons: {
    label: Val;
    /** name of an action in schema.actions */
    action?: string;
    variant?: "primary" | "ghost" | "danger";
  }[];
}

export interface ButtonWidget extends Base {
  kind: "button";
  label: Val;
  action?: string;
  variant?: "primary" | "ghost" | "danger";
}

export interface NavWidget extends Base {
  kind: "nav";
  label: Val;
  /** route to push */
  to: string;
}

export interface EmptyWidget extends Base {
  kind: "empty";
  text?: Val;
}

export interface LoadingWidget extends Base {
  kind: "loading";
  /** rows of skeleton to show */
  rows?: number;
}

export interface ErrorWidget extends Base {
  kind: "error";
  text?: Val;
}

export interface TableWidget extends Base {
  kind: "table";
  columns: { key: string; label: Val }[];
  /** source-slot name whose `.data` array supplies the rows */
  from: string;
  empty?: Val;
}

export interface ChartWidget extends Base {
  kind: "chart";
  /** source-slot name whose `.data` array supplies points */
  from: string;
  /** key on each item to read the numeric y-value */
  yKey: string;
  tone?: Tone;
  label?: Val;
}

export type Widget =
  | PanelWidget
  | StatsWidget
  | ListWidget
  | MetricWidget
  | GaugeWidget
  | SegmentedWidget
  | ToggleWidget
  | ChipWidget
  | FormWidget
  | ActionRowWidget
  | ButtonWidget
  | NavWidget
  | EmptyWidget
  | LoadingWidget
  | ErrorWidget
  | TableWidget
  | ChartWidget;

export type WidgetKind = Widget["kind"];

// ── the document ──────────────────────────────────────────────────────────

export interface UISchemaV2 {
  version: 2;
  title: string;
  eyebrow?: string;
  status?: Val;
  tone?: Tone;
  back?: boolean;
  /** initial state seed (range, toggles, form values…) */
  state?: Record<string, Val>;
  /** named data sources the body binds to */
  data?: Record<string, DataSource>;
  /** named actions buttons/rows can trigger */
  actions?: Record<string, ActionDef>;
  body: Widget[];
}

// ── pure helpers ──────────────────────────────────────────────────────────

/** The shape the renderer resolves templates/whens against. */
export interface Scope {
  state: Record<string, unknown>;
  /** name -> the resolved `.data` payload of that source slot */
  data: Record<string, unknown>;
  /** the current list/table row, when rendering inside one */
  item?: unknown;
}

/**
 * Read a dotted path out of an arbitrary value. Pure, total, never throws:
 * a missing segment (or indexing into a non-object) yields `undefined`. Numeric
 * segments index into arrays. `resolvePath(scope, "")` returns the scope itself.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const raw of path.split(".")) {
    if (cur == null) return undefined;
    const key = raw.trim();
    if (key === "") continue;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      cur = Number.isInteger(idx)
        ? (cur as unknown[])[idx]
        : (cur as unknown as Record<string, unknown>)[key];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

/**
 * Resolve a value against a scope.
 *   - non-string values pass straight through (numbers/bools/null preserved),
 *   - a string that is a SINGLE whole-string token ("{{ x.y }}") returns the
 *     RAW resolved value — so arrays / numbers survive for widgets that need
 *     them (gauge value, list `from`, counters),
 *   - any other string substitutes every token inline (missing -> "").
 */
export function resolveTemplate(val: unknown, scope: Scope): unknown {
  if (typeof val !== "string") return val;
  const whole = val.match(/^\{\{\s*([^}]*?)\s*\}\}$/);
  if (whole) return resolvePath(scope, whole[1].trim());
  return val.replace(TOKEN, (_m, expr: string) => {
    const r = resolvePath(scope, expr.trim());
    return r == null ? "" : String(r);
  });
}

/** Coerce a resolved template result to a string for text display. */
export function resolveText(val: unknown, scope: Scope): string {
  const r = resolveTemplate(val, scope);
  return r == null ? "" : String(r);
}

/** Coerce a resolved template result to a finite number (0 on failure). */
export function resolveNumber(val: unknown, scope: Scope): number {
  const r = resolveTemplate(val, scope);
  const n = typeof r === "number" ? r : Number(r);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Evaluate a `WhenClause` against a scope. Pure. Default (no op, no value) and
 * op "truthy" test truthiness of the resolved path; "=="/"!=" loose-compare the
 * resolved value to the clause literal. An absent clause is treated as visible
 * by the caller (this returns true only for a present clause).
 */
export function evalWhen(when: WhenClause | undefined, scope: Scope): boolean {
  if (!when) return true;
  const left = resolvePath(scope, when.path);
  const op = when.op ?? (when.value !== undefined ? "==" : "truthy");
  switch (op) {
    case "==":
      // loose compare so number 1 matches the JSON literal 1 / "1"
      return left == when.value; // eslint-disable-line eqeqeq
    case "!=":
      return left != when.value; // eslint-disable-line eqeqeq
    case "truthy":
    default:
      return Boolean(left);
  }
}
