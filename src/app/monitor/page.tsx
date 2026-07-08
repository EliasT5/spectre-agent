"use client";

import { useEffect, useState } from "react";
import { spectre, type MonitorEvent, type Connector } from "@/lib/sdk";
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
  Skeleton,
  type Tone,
} from "@/components/ui";
import { Activity, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import "./monitor.css";

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

/** Per-event severity → mon-event-row modifier class. */
const SEV_ROW_CLASS: Record<MonitorEvent["severity"], string> = {
  critical: "mon-event-crit",
  warning: "mon-event-warn",
  info: "",
};

/** Connector status → status-dot tone. */
const CONN_TONE: Record<Connector["status"], Tone> = {
  connected: "ok",
  configured: "ok",
  "needs-setup": "warn",
  off: "off",
  error: "crit",
};

export default function MonitorTab() {
  const [events, setEvents] = useState<MonitorEvent[] | null>(null);
  const [summary, setSummary] = useState({ warnings: 0, criticals: 0 });
  const [err, setErr] = useState("");
  const [connectors, setConnectors] = useState<Connector[] | null>(null);

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
      try {
        const cx = await spectre.connectors();
        if (live) setConnectors(cx.connectors ?? []);
      } catch { /* connectors are best-effort — don't blank the feed */ }
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
    <div className="monitor-tab">
    <TabShell eyebrow="SYSTEM · MONITOR" title="Monitor" status={status} tone={tone}>
      {/* KPI telemetry — tone-colored when non-zero */}
      <Panel
        hud
        icon={<Activity strokeWidth={1.6} />}
        label="LIVE TELEMETRY"
        title="System Vitals"
        aside={
          <span className="mon-link-status">
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
            <span className="mon-empty-error">
              <ShieldAlert size={18} strokeWidth={1.6} />
              {err}
            </span>
          </EmptyState>
        ) : events === null ? (
          <div className="mon-skeleton-list">
            <Skeleton height={54} />
            <Skeleton height={54} />
            <Skeleton height={54} />
            <span className="mon-skeleton-label">Scanning…</span>
          </div>
        ) : count === 0 ? (
          <EmptyState>
            <span className="mon-empty-ok">
              <CheckCircle2 size={18} strokeWidth={1.6} />
              No issues logged ✓
            </span>
          </EmptyState>
        ) : (
          <div className="mon-event-list">
            {events.map((e) => (
              <div key={e.id} className={`mon-event-wrap ${SEV_ROW_CLASS[e.severity]}`}>
                <ListRow
                  head={
                    <span className="mon-row-head">
                      <StatusDot tone={SEV_TONE[e.severity]} />
                      <Chip color={COLOR[e.severity]}>{e.severity}</Chip>
                      <Chip>{e.component}</Chip>
                    </span>
                  }
                  when={new Date(e.created_at).toLocaleTimeString()}
                >
                  {e.description}
                </ListRow>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Connectors — what's linked, no secrets shown */}
      <Panel
        label="connectors"
        meta={connectors ? <span className="mono muted">{connectors.filter((x) => x.status === "connected").length}/{connectors.length} up</span> : undefined}
      >
        {connectors === null ? (
          <div className="mon-skeleton-list">
            <Skeleton height={40} />
            <Skeleton height={40} />
          </div>
        ) : (
          <div className="mon-connector-list">
            {connectors.map((c) => (
              <ListRow
                key={c.name}
                head={
                  <span className="mon-row-head">
                    <StatusDot tone={CONN_TONE[c.status]} />
                    <Chip>{c.name}</Chip>
                  </span>
                }
                when={
                  <Chip color={c.status === "error" ? COLOR.critical : c.status === "needs-setup" ? COLOR.warning : undefined}>
                    {c.status}
                  </Chip>
                }
              >
                {c.detail}
              </ListRow>
            ))}
          </div>
        )}
      </Panel>

      <span className="mon-poll-footer">
        <AlertTriangle size={11} strokeWidth={1.6} className="mon-poll-icon" />
        polling every 10s
      </span>
    </TabShell>
    </div>
  );
}
