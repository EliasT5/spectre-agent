import type { ReactNode } from "react";
import { EmptyState, ListRow, Panel, Row, Stat, StatGrid, TabShell, type Tone } from "./kit";

/**
 * A tab described as DATA. The same renderer draws every schema tab, so any
 * module that returns a TabSchema looks identical to the built-ins for free —
 * this is the "consistent UI schema across modules" contract. For read-mostly
 * surfaces (status, feeds, stats) describe them here and stay on the Glass HUD
 * console without writing markup; for interactive surfaces drop to the
 * imperative kit (or a { kind: "custom" } section). `templates` are ready-made
 * sections.
 */

export type TabSection =
  | { kind: "panel"; label?: ReactNode; title?: ReactNode; icon?: ReactNode; rows?: { label: ReactNode; value: ReactNode }[]; body?: ReactNode }
  | { kind: "stats"; label?: ReactNode; stats: { k: ReactNode; n: ReactNode }[] }
  | { kind: "list"; label?: ReactNode; empty?: ReactNode; items: { id: string; meta?: ReactNode; when?: ReactNode; body: ReactNode }[] }
  | { kind: "custom"; node: ReactNode };

export interface TabSchema {
  title: string;
  eyebrow?: ReactNode;
  status?: ReactNode;
  tone?: Tone;
  back?: boolean;
  sections: TabSection[];
}

function Section({ s }: { s: TabSection }) {
  switch (s.kind) {
    case "panel":
      return (
        <Panel label={s.label} title={s.title} icon={s.icon}>
          {s.rows?.map((r, i) => (
            <Row key={i} label={r.label}>
              {r.value}
            </Row>
          ))}
          {s.body}
        </Panel>
      );
    case "stats":
      return (
        <Panel label={s.label} hud>
          <StatGrid>
            {s.stats.map((st, i) => (
              <Stat key={i} n={st.n} k={st.k} />
            ))}
          </StatGrid>
        </Panel>
      );
    case "list":
      if (!s.items.length) return <EmptyState>{s.empty ?? "Nothing here."}</EmptyState>;
      return (
        <>
          {s.label != null && <span className="label" style={{ padding: "2px 2px 0" }}>{s.label}</span>}
          {s.items.map((it) => (
            <ListRow key={it.id} head={it.meta} when={it.when}>
              {it.body}
            </ListRow>
          ))}
        </>
      );
    case "custom":
      return <>{s.node}</>;
  }
}

export function SchemaTab({ schema }: { schema: TabSchema }) {
  return (
    <TabShell title={schema.title} eyebrow={schema.eyebrow} status={schema.status} tone={schema.tone} back={schema.back}>
      {schema.sections.map((s, i) => (
        <Section key={i} s={s} />
      ))}
    </TabShell>
  );
}

/** Ready-made sections — the "templates" a module composes a tab from. */
export const templates = {
  statusPanel: (
    label: ReactNode,
    rows: { label: ReactNode; value: ReactNode }[],
    opts?: { title?: ReactNode; icon?: ReactNode },
  ): TabSection => ({
    kind: "panel",
    label,
    title: opts?.title,
    icon: opts?.icon,
    rows,
  }),
  stats: (stats: { k: ReactNode; n: ReactNode }[], label?: ReactNode): TabSection => ({
    kind: "stats",
    label,
    stats,
  }),
  feed: (
    items: { id: string; meta?: ReactNode; when?: ReactNode; body: ReactNode }[],
    opts?: { label?: ReactNode; empty?: ReactNode },
  ): TabSection => ({ kind: "list", label: opts?.label, empty: opts?.empty, items }),
};
