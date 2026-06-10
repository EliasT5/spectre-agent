"use client";

import { useEffect, useState } from "react";
import { spectre, type MonitorEvent } from "@/lib/sdk";
import {
  TabShell,
  Panel,
  StatGrid,
  Stat,
  Counter,
  StatusDot,
  ListRow,
  Chip,
  EmptyState,
  type Tone,
} from "@/components/ui";
import { Activity, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";

/**
 * Monitor module — built ENTIRELY on @spectre/sdk (spectre.monitor()) + the kit,
 * with no special core access. Polls every 10s, renders three tone-colored KPI
 * tiles in a HUD panel and a glass event feed. Doubles as the debugging
 * engine's UI. The reference example of "a module is data + the kit."
 */

const COLOR: Record<string, string> = {
  critical: "#ef4444", // == var(--color-error); keep the two reds consistent
  warning: "#e8b94a", // == var(--color-warn)
  info: "#7d77a6",
};

/** Per-event severity → status-dot tone. */
const SEV_TONE: Record<MonitorEvent["severity"], Tone> = {
  critical: "crit",
  warning: "warn",
  info: "off",
};

export default function MonitorTab() {
  const [events, setEvents] = useState<MonitorEvent[] | null>(null);
  const [summary, setSummary] = useState({ warnings: 0, criticals: 0 });
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const d = await spectre.monitor();
        if (!live) return;
        setEvents(d.events ?? []);
        setSummary(d.summary ?? { warnings: 0, criticals: 0 });
        setErr(""); // recover from a transient poll failure
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : "failed to load");
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const status = err
    ? "offline"
    : events === null
      ? "scanning…"
      : summary.criticals > 0
        ? `${summary.criticals} critical`
        : summary.warnings > 0
          ? `${summary.warnings} warnings`
          : "all clear";

  const tone: Tone = err
    ? "off"
    : events === null
      ? "off" // neutral dot while scanning, not a green "ok"
      : summary.criticals > 0
        ? "crit"
        : summary.warnings > 0
          ? "warn"
          : "ok";

  const count = events?.length ?? 0;

  return (
    <TabShell eyebrow="SYSTEM · MONITOR" title="Monitor" status={status} tone={tone}>
      {/* KPI telemetry — tone-colored when non-zero */}
      <Panel
        hud
        icon={<Activity strokeWidth={1.6} />}
        label="LIVE TELEMETRY"
        title="System Vitals"
        aside={
          <span className="mono muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <StatusDot tone={tone} />
            {err ? "link down" : events === null ? "scanning" : "online"}
          </span>
        }
      >
        <StatGrid>
          <Stat
            n={<Counter value={summary.criticals} color={summary.criticals > 0 ? "var(--color-error)" : undefined} />}
            k="critical"
          />
          <Stat
            n={<Counter value={summary.warnings} color={summary.warnings > 0 ? "var(--color-warn)" : undefined} />}
            k="warnings"
          />
          <Stat n={<Counter value={count} />} k="events" />
        </StatGrid>
      </Panel>

      {/* Event feed */}
      <Panel label="event log" meta={<span className="mono muted">{err ? "—" : `${count} entries`}</span>}>
        {err ? (
          <EmptyState>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-error)" }}>
              <ShieldAlert size={18} strokeWidth={1.6} />
              {err}
            </span>
          </EmptyState>
        ) : events === null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="skeleton" style={{ height: 54 }} />
            <div className="skeleton" style={{ height: 54 }} />
            <div className="skeleton" style={{ height: 54 }} />
            <span className="mono muted" style={{ fontSize: 12, textAlign: "center", paddingTop: 4 }}>
              Scanning…
            </span>
          </div>
        ) : count === 0 ? (
          <EmptyState>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--color-success)" }}>
              <CheckCircle2 size={18} strokeWidth={1.6} />
              No issues logged ✓
            </span>
          </EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {events.map((e) => (
              <ListRow
                key={e.id}
                head={
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <StatusDot tone={SEV_TONE[e.severity]} />
                    <Chip color={COLOR[e.severity]}>{e.severity}</Chip>
                    <Chip>{e.component}</Chip>
                  </span>
                }
                when={new Date(e.created_at).toLocaleTimeString()}
              >
                {e.description}
              </ListRow>
            ))}
          </div>
        )}
      </Panel>

      <span className="mono muted" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11 }}>
        <AlertTriangle size={11} strokeWidth={1.6} style={{ opacity: 0.6 }} />
        polling every 10s
      </span>
    </TabShell>
  );
}
