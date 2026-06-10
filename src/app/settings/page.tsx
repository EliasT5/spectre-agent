"use client";

import { useEffect, useMemo, useState, useId, type CSSProperties } from "react";
import { TabShell, Panel, Row, Chip } from "@/components/ui";
import { Cpu, Box, Brain, Check, Sparkles, AppWindow, ShieldCheck, Plus, CalendarDays } from "lucide-react";
import {
  getGlobalMode,
  setGlobalMode,
  clearOverrides,
  overrideCount,
  type OpenDefault,
} from "@/lib/module-open";

type Model = { id: string; provider: string; displayName: string; detected?: boolean };

const OPEN_OPTIONS: { value: OpenDefault; label: string; hint: string }[] = [
  { value: "ask", label: "Ask each time", hint: "RECOMMENDED · CHOOSE ON CLICK, OPTIONALLY REMEMBER" },
  { value: "same", label: "This window", hint: "NAVIGATE IN-APP" },
  { value: "new", label: "New window", hint: "OPEN A SEPARATE WINDOW" },
];

const APPROVAL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "autonomous", label: "Autonomous", hint: "DO EVERYTHING · NO APPROVAL PROMPTS · SELF-IMPROVES" },
  { value: "balanced", label: "Balanced", hint: "RECOMMENDED · RUN ROUTINE WORK FREELY, APPROVE BIG CHANGES" },
  { value: "manual", label: "Manual", hint: "APPROVE EVERYTHING · BABYSIT" },
];

const msBtn: CSSProperties = {
  alignSelf: "flex-start",
  padding: "10px 18px",
  borderRadius: "var(--r)",
  font: "inherit",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

export default function SettingsTab() {
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [coreVersion, setCoreVersion] = useState<number | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [openMode, setOpenMode] = useState<OpenDefault>("ask");
  const [ovCount, setOvCount] = useState(0);
  const [approval, setApproval] = useState<string>("balanced");

  // Microsoft 365 connection (OAuth backend already ships in the core).
  const [ms, setMs] = useState<{ connected: boolean; user_email?: string | null; user_name?: string | null } | null>(null);
  const [msNote, setMsNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadMs() {
    try {
      const r = await fetch("/api/auth/ms-graph/status");
      if (r.ok) setMs(await r.json());
    } catch {
      /* MS Graph optional */
    }
  }

  async function disconnectMs() {
    await fetch("/api/auth/ms-graph/disconnect", { method: "POST" }).catch(() => {});
    setMsNote(null);
    await loadMs();
  }

  // Add-a-provider form → LiteLLM admin (POST /api/providers/models).
  const [addName, setAddName] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addKey, setAddKey] = useState("");
  const [addBase, setAddBase] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadModels() {
    const mRes = await fetch("/api/models");
    if (mRes.ok) {
      const m = await mRes.json();
      setProviders(m.providers ?? []);
      setModels(m.models ?? []);
    }
  }

  async function addProviderModel() {
    if (!addName.trim() || !addModel.trim()) {
      setAddMsg({ ok: false, text: "Name and model id are required." });
      return;
    }
    setAdding(true);
    setAddMsg(null);
    try {
      const res = await fetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelName: addName.trim(),
          model: addModel.trim(),
          apiKey: addKey.trim() || undefined,
          apiBase: addBase.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setAddMsg({ ok: true, text: `Added "${addName.trim()}" — it now appears in Routing below.` });
        setAddName("");
        setAddModel("");
        setAddKey("");
        setAddBase("");
        await loadModels();
      } else {
        setAddMsg({ ok: false, text: j.error || `Failed (HTTP ${res.status}).` });
      }
    } catch (e) {
      setAddMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setAdding(false);
    }
  }

  useEffect(() => {
    (async () => {
      const [mRes, hRes, cRes, aRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/health"),
        fetch("/api/app-config/default_model"),
        fetch("/api/app-config/approval_mode"),
      ]);
      if (aRes.ok) {
        const v = (await aRes.json()).value;
        if (typeof v === "string") setApproval(v);
      }
      if (mRes.ok) {
        const m = await mRes.json();
        setProviders(m.providers ?? []);
        setModels(m.models ?? []);
      }
      if (hRes.ok) setCoreVersion((await hRes.json()).coreApiVersion ?? null);
      if (cRes.ok) {
        const v = (await cRes.json()).value;
        if (typeof v === "string") setDefaultModel(v);
      }
    })();
  }, []);

  useEffect(() => {
    setOpenMode(getGlobalMode());
    setOvCount(overrideCount());
  }, []);

  // MS 365: load status + surface the OAuth-callback result (the core redirects
  // back to /settings?ms_connected=1 or ?ms_error=…), then clean the URL.
  useEffect(() => {
    loadMs();
    const q = new URLSearchParams(window.location.search);
    if (q.get("ms_connected")) setMsNote({ ok: true, text: "Microsoft 365 connected." });
    else if (q.get("ms_error")) setMsNote({ ok: false, text: q.get("ms_error") || "Connection failed." });
    if (q.has("ms_connected") || q.has("ms_error")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  function pickOpen(m: OpenDefault) {
    setGlobalMode(m);
    setOpenMode(m);
  }

  async function pickApproval(value: string) {
    setApproval(value);
    await fetch("/api/app-config/approval_mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  async function saveDefault(value: string) {
    setDefaultModel(value);
    setSaved(false);
    if (value) {
      await fetch("/api/app-config/default_model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    } else {
      // Auto-route = no stored default; the router then chooses per message.
      await fetch("/api/app-config/default_model", { method: "DELETE" });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // Group models by provider for the Models telemetry panel.
  const grouped = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, [models]);

  const autoActive = defaultModel === "";

  return (
    <TabShell
      eyebrow="SYSTEM · SETTINGS"
      title="Settings"
      status={coreVersion !== null ? `core api v${coreVersion}` : ""}
      tone="ok"
    >
      {/* ── Routing ─────────────────────────────────────────── */}
      <Panel
        icon={<Cpu strokeWidth={1.6} />}
        label="DEFAULT MODEL"
        title="Routing"
        hud
        aside={saved ? <Chip on>saved ✓</Chip> : undefined}
      >
        <p className="muted" style={{ margin: "2px 0 14px", fontSize: 13, lineHeight: 1.5 }}>
          What Spectre routes to when you don&apos;t pick. Auto lets the router choose the best
          model per message.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Auto-route row */}
          <SelectRow active={autoActive} onClick={() => saveDefault("")}>
            <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
              <Sparkles
                strokeWidth={1.6}
                size={16}
                style={{ color: "var(--color-accent-hover)", flexShrink: 0 }}
              />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "var(--color-text)" }}>Auto-route</span>
                <span className="mono muted" style={{ fontSize: 11, letterSpacing: ".04em" }}>
                  RECOMMENDED · ROUTER PICKS PER MESSAGE
                </span>
              </span>
            </span>
            {autoActive && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)" }} />}
          </SelectRow>

          {/* Model rows */}
          {models.map((m) => {
            const active = defaultModel === m.id;
            return (
              <SelectRow key={m.id} active={active} onClick={() => saveDefault(m.id)}>
                <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.displayName}
                  </span>
                  <Chip on={active}>{m.provider}</Chip>
                </span>
                {active && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)" }} />}
              </SelectRow>
            );
          })}
        </div>
      </Panel>

      {/* ── Interface ───────────────────────────────────────── */}
      <Panel
        icon={<AppWindow strokeWidth={1.6} />}
        label="BLOB"
        title="Opening modules"
        aside={
          ovCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                clearOverrides();
                setOvCount(0);
              }}
              style={{
                background: "none",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--pill, 999px)",
                color: "var(--color-text-muted)",
                font: "inherit",
                fontSize: 11,
                padding: "3px 9px",
                cursor: "pointer",
              }}
            >
              clear {ovCount} saved
            </button>
          ) : undefined
        }
      >
        <p className="muted" style={{ margin: "2px 0 14px", fontSize: 13, lineHeight: 1.5 }}>
          What happens when you click a module in the blob. &ldquo;Ask&rdquo; lets you choose per
          click and optionally remember it for that module.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {OPEN_OPTIONS.map((o) => (
            <SelectRow key={o.value} active={openMode === o.value} onClick={() => pickOpen(o.value)}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "var(--color-text)" }}>{o.label}</span>
                <span className="mono muted" style={{ fontSize: 11, letterSpacing: ".04em" }}>
                  {o.hint}
                </span>
              </span>
              {openMode === o.value && (
                <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)" }} />
              )}
            </SelectRow>
          ))}
        </div>
      </Panel>

      {/* ── Autonomy ────────────────────────────────────────── */}
      <Panel icon={<ShieldCheck strokeWidth={1.6} />} label="AUTONOMY" title="How much Spectre acts on its own">
        <p className="muted" style={{ margin: "2px 0 14px", fontSize: 13, lineHeight: 1.5 }}>
          Governs whether Spectre asks before acting — self-improving its skills, applying workshop
          changes, running background work. Set it loose, or keep it on a leash.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {APPROVAL_OPTIONS.map((o) => (
            <SelectRow key={o.value} active={approval === o.value} onClick={() => pickApproval(o.value)}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "var(--color-text)" }}>{o.label}</span>
                <span className="mono muted" style={{ fontSize: 11, letterSpacing: ".04em" }}>{o.hint}</span>
              </span>
              {approval === o.value && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)" }} />}
            </SelectRow>
          ))}
        </div>
      </Panel>

      {/* ── Microsoft 365 ───────────────────────────────────── */}
      <Panel
        icon={<CalendarDays strokeWidth={1.6} />}
        label="CALENDAR"
        title="Microsoft 365"
        aside={ms?.connected ? <Chip on>connected ✓</Chip> : undefined}
      >
        <p className="muted" style={{ margin: "2px 0 14px", fontSize: 13, lineHeight: 1.5 }}>
          Connect your Microsoft 365 account so Spectre can read your calendar
          (<span className="mono">calendar.today</span> / <span className="mono">calendar.upcoming</span>).
          Requires <span className="mono">MS_GRAPH_CLIENT_ID</span> / <span className="mono">SECRET</span> /
          <span className="mono"> REDIRECT_URI</span> set in the core.
        </p>
        {ms?.connected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Row label={ms.user_name || ms.user_email || "Connected account"}>
              {ms.user_email || "microsoft 365"}
            </Row>
            <button
              type="button"
              onClick={disconnectMs}
              className="tap-press"
              style={{
                ...msBtn,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/ms-graph/login";
            }}
            className="tap-press"
            style={{
              ...msBtn,
              background: "var(--color-accent)",
              border: "1px solid var(--color-accent)",
              color: "#fff",
            }}
          >
            Connect Microsoft 365
          </button>
        )}
        {msNote && (
          <span style={{ display: "block", marginTop: 12, fontSize: 12.5, lineHeight: 1.5, color: msNote.ok ? "var(--color-accent-hover)" : "#f87171" }}>
            {msNote.text}
          </span>
        )}
      </Panel>

      {/* ── Providers ───────────────────────────────────────── */}
      <Panel icon={<Box strokeWidth={1.6} />} label="DETECTED" title="Providers">
        <p className="muted" style={{ margin: "2px 0 12px", fontSize: 13, lineHeight: 1.5 }}>
          Providers Spectre detected. The standard brain runs through your gateway
          (<span className="mono">litellm</span>) with your own keys/models. Subscription-driven
          CLIs (Claude/Codex/Gemini) are forbidden by default — enable per-operator with the
          <span className="mono"> SPECTRE_ALLOW_*_CLI</span> flags.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {providers.length ? (
            providers.map((p) => <Chip key={p}>{p}</Chip>)
          ) : (
            <span className="muted">—</span>
          )}
        </div>
      </Panel>

      {/* ── Add a provider (LiteLLM gateway, runtime) ───────── */}
      <Panel icon={<Plus strokeWidth={1.6} />} label="GATEWAY" title="Add a provider">
        <p className="muted" style={{ margin: "2px 0 14px", fontSize: 13, lineHeight: 1.5 }}>
          Register a model on your LiteLLM gateway at runtime — it appears in Routing above
          automatically. Needs a LiteLLM proxy with a master key; a plain Ollama gateway has no
          admin API, so add those in <span className="mono">litellm-config.yaml</span> and restart.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Name" hint="WHAT SPECTRE REQUESTS · e.g. spectre-pro" value={addName} onChange={setAddName} />
          <Field label="Model id" hint="PROVIDER-PREFIXED · e.g. anthropic/claude-sonnet-4-6" value={addModel} onChange={setAddModel} />
          <Field label="API key" hint="OPTIONAL · YOUR PROVIDER KEY" value={addKey} onChange={setAddKey} type="password" />
          <Field label="API base" hint="OPTIONAL · CUSTOM ENDPOINT URL" value={addBase} onChange={setAddBase} />
          <button
            type="button"
            onClick={addProviderModel}
            disabled={adding}
            className="tap-press"
            style={{
              alignSelf: "flex-start",
              marginTop: 2,
              padding: "10px 18px",
              borderRadius: "var(--r)",
              background: "var(--color-accent)",
              border: "1px solid var(--color-accent)",
              color: "#fff",
              font: "inherit",
              fontWeight: 600,
              fontSize: 13,
              cursor: adding ? "default" : "pointer",
              opacity: adding ? 0.6 : 1,
            }}
          >
            {adding ? "Adding…" : "Add to gateway"}
          </button>
          {addMsg && (
            <span style={{ fontSize: 12.5, lineHeight: 1.5, color: addMsg.ok ? "var(--color-accent-hover)" : "#f87171" }}>
              {addMsg.text}
            </span>
          )}
        </div>
      </Panel>

      {/* ── Models ──────────────────────────────────────────── */}
      <Panel
        icon={<Brain strokeWidth={1.6} />}
        label={`${models.length} AVAILABLE`}
        title="Models"
      >
        {grouped.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    letterSpacing: ".08em",
                    textTransform: "uppercase",
                    color: "var(--color-text-muted)",
                    padding: "0 0 8px",
                    borderBottom: "1px solid var(--color-border)",
                    marginBottom: 4,
                  }}
                >
                  {provider} · {list.length}
                </div>
                {list.map((m) => (
                  <Row key={m.id} label={m.displayName}>
                    {m.provider}
                  </Row>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </Panel>
    </TabShell>
  );
}

function SelectRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tap-press"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: "12px 14px",
        borderRadius: "var(--r)",
        cursor: "pointer",
        background: active ? "rgba(99, 102, 241, 0.12)" : "var(--color-surface)",
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
        boxShadow: active ? "var(--glow-sm)" : "none",
        transition: "border-color .18s ease, background .18s ease, box-shadow .18s ease",
        font: "inherit",
        color: "var(--color-text)",
      }}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)" }}>{label}</span>
        <span className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>{hint}</span>
      </span>
      <input
        id={id}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        spellCheck={false}
        autoComplete="off"
        style={{
          padding: "9px 12px",
          borderRadius: "var(--r)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          font: "inherit",
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}
