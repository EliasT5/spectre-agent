"use client";

/**
 * SchemaRuntime — renders a UI Schema v2 document on the shared kit.
 *
 * A Data-mode module ships its UI AS DATA (a `UISchemaV2`); this client
 * component turns that data into the same Glass-HUD console the built-ins use,
 * with ZERO module React. It is the imperative sibling of the pure schema-v2.ts:
 * the schema can only reach the SDK through the CLOSED `SDK_CALLS` table below,
 * and only for calls ALSO granted by `permissions.sdk`. There is no `eval`, no
 * `Function`, no dynamic import — a schema is data, never code.
 *
 * Lifecycle (one effect): seed state from `schema.state`; start every sdk data
 * source AND every module data source (loading -> ready/error); `pollMs` runs
 * via setInterval; ALL intervals are cleared on unmount and setState is guarded
 * by a live ref so a late poll can't write into an unmounted tree.
 *
 * Module sources/steps are SELF-SCOPED: `spectre.module(moduleId)` hard-binds the
 * page's id, so a schema can only ever reach ITS OWN backend — there is no
 * target-module field. They need no sdk grant (the core gates them by manifest
 * permission). Sdk sources still require both the closed SDK_CALLS table AND a
 * permissions.sdk grant. There is no `eval`, no `Function`, no dynamic import.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  Box,
  Boxes,
  Brain,
  Calendar,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Heart,
  ListChecks,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { spectre } from "@/lib/sdk";
import type { ModulePermissions } from "@/lib/module-manifest";
import { SDK_CALLS, sdkAllowed, isSafeModulePath } from "./sdk-calls";
import {
  Bar,
  Button,
  Chip,
  Counter,
  EmptyState,
  ErrorState,
  Field,
  Input,
  ListRow,
  Panel,
  Row,
  Segmented,
  Skeleton,
  Sparkline,
  Stat,
  StatGrid,
  Table,
  TabShell,
  Toggle,
  Toolbar,
} from "./kit";
import {
  evalWhen,
  resolveNumber,
  resolvePath,
  resolveTemplate,
  resolveText,
  type ActionStep,
  type DataSource,
  type Scope,
  type UISchemaV2,
  type Val,
  type Widget,
} from "./schema-v2";

// The CLOSED sdk dispatch table (SDK_CALLS) + its grant gate (sdkAllowed) now
// live in ./sdk-calls and are SHARED with the Code-mode bridge — one source of
// truth for what untrusted module code may call. Imported above.

/** Curated lucide-by-name map (the Nodes.tsx idiom). Fallback: Box. */
const ICONS: Record<string, LucideIcon> = {
  Activity,
  AlertTriangle,
  Bell,
  Bot,
  Box,
  Boxes,
  Brain,
  Calendar,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Heart,
  ListChecks,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Wifi,
  Zap,
};

function iconFor(name: Val | undefined): ReactNode {
  if (typeof name !== "string") return null;
  const Cmp = ICONS[name] ?? Box;
  return <Cmp strokeWidth={1.6} />;
}

// ── data-source slots ───────────────────────────────────────────────────────
type SlotStatus = "loading" | "ready" | "error" | "deferred" | "denied";
interface Slot {
  status: SlotStatus;
  data: unknown;
  error?: string;
}

const initialSlots = (
  data: Record<string, DataSource> | undefined,
  perms: ModulePermissions,
): Record<string, Slot> => {
  const out: Record<string, Slot> = {};
  for (const [name, src] of Object.entries(data ?? {})) {
    if (src.source === "module") {
      // Self-scoped — fetched at lifecycle start (no sdk grant needed).
      out[name] = { status: "loading", data: null };
    } else if (!sdkAllowed(src.call, perms)) {
      out[name] = { status: "denied", data: null, error: src.call };
    } else {
      out[name] = { status: "loading", data: null };
    }
  }
  return out;
};

export function SchemaRuntime({
  moduleId,
  schema,
  permissions,
}: {
  moduleId: string;
  schema: UISchemaV2;
  permissions: ModulePermissions;
}) {
  const router = useRouter();

  // Seed module state from schema.state once (initializer — never re-seed).
  const [state, setState] = useState<Record<string, unknown>>(
    () => ({ ...schema.state }),
  );
  const [slots, setSlots] = useState<Record<string, Slot>>(
    () => initialSlots(schema.data, permissions),
  );

  // Live ref guards every async setState against an unmounted tree.
  const liveRef = useRef(true);
  // Latest state for action steps that read state without re-binding the effect.
  const stateRef = useRef(state);
  stateRef.current = state;

  const scopeOf = useCallback(
    (item?: unknown): Scope => {
      const dataMap: Record<string, unknown> = {};
      for (const [name, slot] of Object.entries(slots)) dataMap[name] = slot.data;
      return { state: stateRef.current, data: dataMap, item };
    },
    [slots],
  );

  // Run ONE named data source. Module sources are self-scoped (no sdk gate);
  // sdk sources require the closed table AND a permissions.sdk grant.
  const runSource = useCallback(
    async (name: string, src: DataSource) => {
      try {
        let result: unknown;
        if (src.source === "module") {
          // Self-scoped to THIS page's module — there is no target-id field.
          // Path traversal guard (mirrors module-bridge.ts via shared isSafeModulePath).
          if (!isSafeModulePath(src.endpoint)) return;
          result = await spectre.module(moduleId).call(src.endpoint);
        } else {
          if (!sdkAllowed(src.call, permissions)) return; // refused before fetch
          const fn = SDK_CALLS[src.call];
          const args = (src.args ?? []).map(
            (a) => resolveTemplate(a, scopeOf()) as Val,
          );
          result = await fn(...args);
        }
        if (!liveRef.current) return;
        setSlots((prev) => ({ ...prev, [name]: { status: "ready", data: result } }));
      } catch (e) {
        if (!liveRef.current) return;
        setSlots((prev) => ({
          ...prev,
          [name]: {
            status: "error",
            data: null,
            error: e instanceof Error ? e.message : "source failed",
          },
        }));
      }
    },
    [moduleId, permissions, scopeOf],
  );

  // Lifecycle: initial fetch of every allowed sdk source + every module source,
  // plus poll intervals. Intentionally runs once per (schema, permissions,
  // moduleId). scopeOf/runSource are stable enough; we deliberately don't re-run
  // on every state tick.
  useEffect(() => {
    liveRef.current = true;
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const [name, src] of Object.entries(schema.data ?? {})) {
      // sdk sources need a grant; module sources are self-scoped (no gate).
      if (src.source === "sdk" && !sdkAllowed(src.call, permissions)) continue;
      void runSource(name, src);
      if (src.pollMs && src.pollMs > 0) {
        timers.push(setInterval(() => void runSource(name, src), src.pollMs));
      }
    }
    return () => {
      liveRef.current = false;
      for (const t of timers) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, permissions, moduleId]);

  const runAction = useCallback(
    async (name?: string) => {
      if (!name) return;
      const def = schema.actions?.[name];
      if (!def) return;
      for (const step of def.steps as ActionStep[]) {
        if (!liveRef.current) return;
        try {
          if (step.step === "sdk") {
            if (!sdkAllowed(step.call, permissions)) continue; // refused, no fetch
            const args = (step.args ?? []).map(
              (a) => resolveTemplate(a, scopeOf()) as Val,
            );
            const result = await SDK_CALLS[step.call](...args);
            if (step.assignTo && liveRef.current) {
              const key = step.assignTo;
              setState((prev) => ({ ...prev, [key]: result as Val }));
            }
          } else if (step.step === "refetch") {
            const names =
              step.names ??
              Object.keys(schema.data ?? {}).filter((n) => {
                const s = schema.data?.[n]?.source;
                return s === "sdk" || s === "module";
              });
            for (const n of names) {
              const src = schema.data?.[n];
              if (src) {
                if (liveRef.current) {
                  setSlots((prev) => ({
                    ...prev,
                    [n]: { ...(prev[n] ?? { data: null }), status: "loading" },
                  }));
                }
                await runSource(n, src);
              }
            }
          } else if (step.step === "setState") {
            const patch: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(step.patch))
              patch[k] = resolveTemplate(v, scopeOf());
            if (liveRef.current) setState((prev) => ({ ...prev, ...patch }));
          } else if (step.step === "navigate") {
            router.push(step.to);
          } else if (step.step === "module") {
            // Call THIS module's OWN backend (self-scoped). method defaults POST.
            // Path traversal guard (mirrors module-bridge.ts via shared isSafeModulePath).
            if (!isSafeModulePath(step.endpoint)) continue;
            const method = step.method ?? "POST";
            let payload: unknown;
            if (typeof step.body === "string") {
              // "@form:k1,k2" — pull those state keys into a flat object.
              const m = step.body.match(/^@form:(.*)$/);
              if (m) {
                const obj: Record<string, unknown> = {};
                for (const k of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
                  obj[k] = stateRef.current[k];
                }
                payload = obj;
              }
            } else if (step.body && typeof step.body === "object") {
              const obj: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(step.body))
                obj[k] = resolveTemplate(v, scopeOf());
              payload = obj;
            }
            const init: RequestInit = { method };
            if (method !== "GET") {
              init.body = JSON.stringify(payload ?? {});
            }
            const result = await spectre.module(moduleId).call(step.endpoint, init);
            if (step.assignTo && liveRef.current) {
              const key = step.assignTo;
              setState((prev) => ({ ...prev, [key]: result as Val }));
            }
          }
        } catch {
          // a failing step shouldn't crash the tab; subsequent steps still run
        }
      }
    },
    [moduleId, permissions, router, runSource, schema.actions, schema.data, scopeOf],
  );

  // Resolve a widget `from` ("slotName" or "slotName.inner.path") to the owning
  // slot (for its loading/error/deferred notice) and the array at that path.
  const fromSlot = (
    from: string,
  ): { slot: Slot | undefined; items: unknown[] } => {
    const dot = from.indexOf(".");
    const slotName = dot === -1 ? from : from.slice(0, dot);
    const innerPath = dot === -1 ? "" : from.slice(dot + 1);
    const slot = slots[slotName];
    const raw = innerPath ? resolvePath(slot?.data, innerPath) : slot?.data;
    return { slot, items: Array.isArray(raw) ? raw : [] };
  };

  // ── widget rendering ──────────────────────────────────────────────────────
  const renderWidget = (w: Widget, key: number, scope: Scope): ReactNode => {
    if (!evalWhen(w.when, scope)) return null;
    switch (w.kind) {
      case "panel":
        return (
          <Panel
            key={key}
            icon={iconFor(w.icon)}
            label={w.label != null ? resolveText(w.label, scope) : undefined}
            title={w.title != null ? resolveText(w.title, scope) : undefined}
            aside={w.aside != null ? resolveText(w.aside, scope) : undefined}
            hud={w.hud}
            live={w.live}
          >
            {w.rows?.map((r, i) => (
              <Row key={i} label={resolveText(r.label, scope)}>
                {resolveText(r.value, scope)}
              </Row>
            ))}
            {w.body?.map((child, i) => renderWidget(child, i, scope))}
          </Panel>
        );

      case "stats":
        return (
          <Panel key={key} label={w.label != null ? resolveText(w.label, scope) : undefined} hud={w.hud ?? true}>
            <StatGrid>
              {w.stats.map((st, i) => (
                <Stat
                  key={i}
                  k={resolveText(st.k, scope)}
                  n={
                    st.counter ? (
                      <Counter value={resolveNumber(st.n, scope)} color={st.color} />
                    ) : (
                      resolveText(st.n, scope)
                    )
                  }
                />
              ))}
            </StatGrid>
          </Panel>
        );

      case "metric":
        return (
          <Stat
            key={key}
            k={resolveText(w.k, scope)}
            n={
              w.counter ? (
                <Counter value={resolveNumber(w.n, scope)} color={w.color} />
              ) : (
                resolveText(w.n, scope)
              )
            }
          />
        );

      case "gauge":
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {w.label != null && (
              <span className="label" style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{resolveText(w.label, scope)}</span>
                <span className="mono">{Math.round(resolveNumber(w.value, scope) * 100)}%</span>
              </span>
            )}
            <Bar value={resolveNumber(w.value, scope)} />
          </div>
        );

      case "list": {
        const { slot, items } = fromSlot(w.from);
        const slotNode = slotNotice(slot);
        if (slotNode) return <div key={key}>{slotNode}</div>;
        const rows = items.filter((it) => evalWhen(w.rowWhen, scopeOf(it)));
        if (!rows.length)
          return <EmptyState key={key}>{w.empty != null ? resolveText(w.empty, scope) : "Nothing here."}</EmptyState>;
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {w.label != null && (
              <span className="label" style={{ padding: "2px 2px 0" }}>
                {resolveText(w.label, scope)}
              </span>
            )}
            {rows.map((it, i) => {
              const rowScope = scopeOf(it);
              return (
                <ListRow
                  key={i}
                  head={w.rowHead != null ? resolveText(w.rowHead, rowScope) : undefined}
                  when={w.rowMeta != null ? resolveText(w.rowMeta, rowScope) : undefined}
                >
                  {w.rowBody != null ? resolveText(w.rowBody, rowScope) : null}
                </ListRow>
              );
            })}
          </div>
        );
      }

      case "table": {
        const { slot, items } = fromSlot(w.from);
        const slotNode = slotNotice(slot);
        if (slotNode) return <div key={key}>{slotNode}</div>;
        const rows = items.map((it) => {
          const row: Record<string, ReactNode> = {};
          for (const c of w.columns) {
            const v = resolvePath(it, c.key);
            row[c.key] = v == null ? "" : String(v);
          }
          return row;
        });
        return (
          <Table
            key={key}
            columns={w.columns.map((c) => ({ key: c.key, label: resolveText(c.label, scope) }))}
            rows={rows}
            empty={w.empty != null ? resolveText(w.empty, scope) : undefined}
          />
        );
      }

      case "chart": {
        const { slot, items } = fromSlot(w.from);
        const slotNode = slotNotice(slot);
        if (slotNode) return <div key={key}>{slotNode}</div>;
        const values = items.map((it) => {
          const v = resolvePath(it, w.yKey);
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : 0;
        });
        return (
          <Panel key={key} label={w.label != null ? resolveText(w.label, scope) : undefined}>
            <Sparkline values={values} tone={w.tone ?? "ok"} />
          </Panel>
        );
      }

      case "segmented": {
        const cur = String(resolvePath(scope, `state.${w.bind}`) ?? "");
        return (
          <Segmented
            key={key}
            value={cur}
            options={w.options.map((o) => ({ value: o.value, label: resolveText(o.label, scope) }))}
            onChange={(v) => setState((prev) => ({ ...prev, [w.bind]: v }))}
          />
        );
      }

      case "toggle": {
        const on = Boolean(resolvePath(scope, `state.${w.bind}`));
        return (
          <Toggle key={key} on={on} onClick={() => setState((prev) => ({ ...prev, [w.bind]: !on }))}>
            {resolveText(w.label, scope)}
          </Toggle>
        );
      }

      case "chip":
        return (
          <Chip key={key} on={w.on} color={w.color}>
            {resolveText(w.label, scope)}
          </Chip>
        );

      case "form":
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {w.fields.map((f, i) => (
              <Field key={i} label={resolveText(f.label, scope)}>
                <Input
                  type={f.type ?? "text"}
                  placeholder={f.placeholder != null ? resolveText(f.placeholder, scope) : undefined}
                  value={String(resolvePath(scope, `state.${f.bind}`) ?? "")}
                  onChange={(e) => {
                    const val = e.target.value;
                    setState((prev) => ({ ...prev, [f.bind]: val }));
                  }}
                />
              </Field>
            ))}
          </div>
        );

      case "actionRow":
        return (
          <Toolbar key={key}>
            {w.buttons.map((b, i) => (
              <Button key={i} variant={b.variant ?? "primary"} onClick={() => void runAction(b.action)}>
                {resolveText(b.label, scope)}
              </Button>
            ))}
          </Toolbar>
        );

      case "button":
        return (
          <Button key={key} variant={w.variant ?? "primary"} onClick={() => void runAction(w.action)}>
            {resolveText(w.label, scope)}
          </Button>
        );

      case "nav":
        return (
          <Button key={key} variant="ghost" onClick={() => router.push(w.to)}>
            {resolveText(w.label, scope)}
          </Button>
        );

      case "empty":
        return <EmptyState key={key}>{w.text != null ? resolveText(w.text, scope) : "Nothing here."}</EmptyState>;

      case "loading":
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {Array.from({ length: Math.max(1, w.rows ?? 3) }).map((_, i) => (
              <Skeleton key={i} />
            ))}
          </div>
        );

      case "error":
        return <ErrorState key={key}>{w.text != null ? resolveText(w.text, scope) : "Something went wrong."}</ErrorState>;

      default:
        // Unknown widget kind — never throw; show a dim notice.
        return (
          <ErrorState key={key}>
            <span style={{ opacity: 0.6 }}>unsupported widget: {(w as { kind?: string }).kind ?? "unknown"}</span>
          </ErrorState>
        );
    }
  };

  const scope = scopeOf();

  return (
    <TabShell
      title={schema.title}
      eyebrow={schema.eyebrow}
      status={schema.status != null ? resolveText(schema.status, scope) : undefined}
      tone={schema.tone}
      back={schema.back ?? true}
    >
      {schema.body.map((w, i) => renderWidget(w, i, scope))}
      <span className="mono muted" style={{ fontSize: 11, opacity: 0.7 }}>
        module: {moduleId}
      </span>
    </TabShell>
  );
}

/**
 * A source-slot's non-ready notice (skeleton / error / denied), or null.
 *
 * The 'deferred' branch is now DEAD: P2c wires module sources to fetch at
 * lifecycle start, so they go loading -> ready/error and never sit deferred.
 * The branch (and the SlotStatus member) are kept for type completeness.
 */
function slotNotice(slot: Slot | undefined): ReactNode {
  if (!slot) return null;
  if (slot.status === "loading")
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton />
        <Skeleton />
      </div>
    );
  if (slot.status === "error") return <ErrorState>{slot.error ?? "source failed"}</ErrorState>;
  if (slot.status === "denied")
    return <ErrorState>permission denied: {slot.error}</ErrorState>;
  if (slot.status === "deferred")
    return (
      <EmptyState>
        <span style={{ opacity: 0.6 }}>module backend deferred</span>
      </EmptyState>
    );
  return null;
}
