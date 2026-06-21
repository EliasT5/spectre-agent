"use client";

import "./settings.css";

import { useEffect, useMemo, useState, useId } from "react";
import { SpectreBackButton } from "@/components/SpectreBackButton";
import {
  Cpu,
  Box,
  Brain,
  Check,
  Sparkles,
  AppWindow,
  ShieldCheck,
  Plus,
  CalendarDays,
  GitBranch,
  Terminal,
} from "lucide-react";
import {
  getGlobalMode,
  setGlobalMode,
  clearOverrides,
  overrideCount,
  type OpenDefault,
} from "@/lib/module-open";

// ── Types ────────────────────────────────────────────────────────────────────

type Model = {
  id: string;
  provider: string;
  displayName: string;
  available: boolean;
  unavailableReason?: string;
  reasoning?: boolean;
  effortLevels?: string[];
  orchestratable?: boolean;
  detected?: boolean;
};

type CliRow = {
  id: string;
  label: string;
  enabled: boolean;
  envDefault: boolean;
  envVar: string;
  canManage: boolean;
  binaryOnPath: boolean;
};
type CliState = { uiAllowed: boolean; items: CliRow[] };

// ── Constants ────────────────────────────────────────────────────────────────

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

// Fallback list — used when /api/models doesn't return CLI providers
const FALLBACK_SPECIALISTS: { id: string; provider: string; displayName: string }[] = [
  { id: "claude-code-haiku",   provider: "claude-code", displayName: "Claude Haiku 4.5" },
  { id: "claude-code-sonnet",  provider: "claude-code", displayName: "Claude Sonnet 4.6" },
  { id: "claude-code-opus",    provider: "claude-code", displayName: "Claude Opus 4.7" },
  { id: "gemini-cli-flash",    provider: "gemini-cli",  displayName: "Gemini 2.5 Flash" },
  { id: "gemini-cli-pro",      provider: "gemini-cli",  displayName: "Gemini 3 Pro" },
  { id: "gemini-cli-auto",     provider: "gemini-cli",  displayName: "Gemini 3 Auto" },
  { id: "codex-cli-mini",      provider: "codex-cli",   displayName: "GPT 5.4 Mini" },
  { id: "codex-cli-gpt55",     provider: "codex-cli",   displayName: "GPT 5.5" },
  { id: "codex-cli-codex",     provider: "codex-cli",   displayName: "GPT 5.3 Codex" },
];
const VENDOR_LABELS: Record<string, string> = {
  "claude-code": "Claude",
  "gemini-cli":  "Gemini",
  "codex-cli":   "Codex",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsTab() {
  const [providers, setProviders] = useState<string[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [coreVersion, setCoreVersion] = useState<number | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [openMode, setOpenMode] = useState<OpenDefault>("ask");
  const [ovCount, setOvCount] = useState(0);
  const [approval, setApproval] = useState<string>("balanced");
  const [error, setError] = useState<string | null>(null);

  // AI Composition
  const [orchestrate, setOrchestrate] = useState(false);
  const [orchTargets, setOrchTargets] = useState<string[]>([]);
  const [compSaved, setCompSaved] = useState(false);

  // Reasoning effort (persisted to app_config.reasoning_effort)
  const [reasoningEffort, setReasoningEffort] = useState<string>("");

  // Microsoft 365 connection
  const [ms, setMs] = useState<{ connected: boolean; user_email?: string | null; user_name?: string | null } | null>(null);
  const [msNote, setMsNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [msLoading, setMsLoading] = useState(true);
  const [msDisconnecting, setMsDisconnecting] = useState(false);

  // Add-a-provider form
  const [addName, setAddName] = useState("");
  const [addModel, setAddModel] = useState("");
  const [addKey, setAddKey] = useState("");
  const [addBase, setAddBase] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // CLI providers (Claude/Codex/Gemini) — runtime enable, gated by the core's
  // SPECTRE_ALLOW_CLI_UI master flag.
  const [cli, setCli] = useState<CliState | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [cliMsg, setCliMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadMs() {
    setMsLoading(true);
    try {
      const r = await fetch("/api/auth/ms-graph/status");
      if (r.ok) setMs(await r.json());
      else setMs({ connected: false });
    } catch {
      setMs({ connected: false });
    } finally {
      setMsLoading(false);
    }
  }

  async function disconnectMs() {
    setMsDisconnecting(true);
    try {
      await fetch("/api/auth/ms-graph/disconnect", { method: "POST" }).catch(() => {});
      setMsNote(null);
      await loadMs();
    } finally {
      setMsDisconnecting(false);
    }
  }

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
        setAddMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${res.status}).` });
      }
    } catch (e) {
      setAddMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setAdding(false);
    }
  }

  async function loadCli() {
    try {
      const r = await fetch("/api/providers/cli");
      if (r.ok) setCli(await r.json());
    } catch {
      // fail-soft — the card just won't render its rows
    }
  }

  async function toggleCli(id: string, enabled: boolean) {
    setCliBusy(id);
    setCliMsg(null);
    try {
      const r = await fetch("/api/providers/cli", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setCli(j as CliState);
        // The Routing / Models lists derive availability from the same gate.
        await loadModels();
      } else {
        setCliMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setCliMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setCliBusy(null);
    }
  }

  useEffect(() => {
    void (async () => {
      const [mRes, hRes, cRes, aRes, orchRes, targRes, effortRes] = await Promise.all([
        fetch("/api/models"),
        fetch("/api/health"),
        fetch("/api/app-config/default_model"),
        fetch("/api/app-config/approval_mode"),
        fetch("/api/app-config/orchestrate"),
        fetch("/api/app-config/orchestration_targets"),
        fetch("/api/app-config/reasoning_effort"),
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
      if (orchRes.ok) {
        const v = (await orchRes.json()).value;
        setOrchestrate(v === "1");
      }
      if (targRes.ok) {
        const v = (await targRes.json()).value;
        if (typeof v === "string" && v) setOrchTargets(v.split(",").map((s: string) => s.trim()).filter(Boolean));
      }
      if (effortRes.ok) {
        const v = (await effortRes.json()).value;
        if (typeof v === "string") setReasoningEffort(v);
      }
    })();
  }, []);

  useEffect(() => {
    setOpenMode(getGlobalMode());
    setOvCount(overrideCount());
  }, []);

  useEffect(() => {
    void loadCli();
  }, []);

  useEffect(() => {
    void loadMs();
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
    try {
      await fetch("/api/app-config/approval_mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save approval mode.");
    }
  }

  async function saveDefault(value: string) {
    setDefaultModel(value);
    setSaved(false);
    try {
      if (value) {
        await fetch("/api/app-config/default_model", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      } else {
        await fetch("/api/app-config/default_model", { method: "DELETE" });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save default model.");
    }
  }

  async function saveOrchestrate(on: boolean) {
    setOrchestrate(on);
    try {
      if (on) {
        await fetch("/api/app-config/orchestrate", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "1" }),
        });
      } else {
        await fetch("/api/app-config/orchestrate", { method: "DELETE" });
      }
      flashCompSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save orchestration setting.");
    }
  }

  async function saveOrchTargets(targets: string[]) {
    setOrchTargets(targets);
    try {
      if (targets.length === 0) {
        await fetch("/api/app-config/orchestration_targets", { method: "DELETE" });
      } else {
        await fetch("/api/app-config/orchestration_targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: targets.join(",") }),
        });
      }
      flashCompSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save orchestration targets.");
    }
  }

  function flashCompSaved() {
    setCompSaved(true);
    setTimeout(() => setCompSaved(false), 1500);
  }

  async function saveReasoningEffort(level: string) {
    setReasoningEffort(level);
    try {
      if (level) {
        await fetch("/api/app-config/reasoning_effort", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: level }),
        });
      } else {
        await fetch("/api/app-config/reasoning_effort", { method: "DELETE" });
      }
      flashCompSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save reasoning effort.");
    }
  }

  function toggleTarget(id: string) {
    const next = orchTargets.includes(id)
      ? orchTargets.filter((t) => t !== id)
      : [...orchTargets, id];
    void saveOrchTargets(next);
  }

  // Group models by provider for the Models panel
  const grouped = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries());
  }, [models]);

  // The selected brain model (for showing the effort meter)
  const brainModel = useMemo(() => models.find((m) => m.id === defaultModel) ?? null, [models, defaultModel]);

  // Derive orchestratable specialist list (with orchestratable flag), fall back to hardcoded
  const specialists = useMemo(() => {
    const fromApi = models.filter((m) => m.orchestratable === true);
    if (fromApi.length > 0) return fromApi;
    // fallback: use CLI providers from hardcoded list (add available:true for compat)
    return FALLBACK_SPECIALISTS.map((s) => ({ ...s, available: true }));
  }, [models]);

  const specialistGroups = useMemo(() => {
    const map = new Map<string, typeof specialists>();
    for (const s of specialists) {
      const list = map.get(s.provider) ?? [];
      list.push(s);
      map.set(s.provider, list);
    }
    return Array.from(map.entries());
  }, [specialists]);

  const autoActive = defaultModel === "";

  return (
    <div className="settings-page">
      <SpectreBackButton />

      <div className="settings-col">
        {/* ── Header ─────────────────────────────────────────── */}
        <header className="settings-header" style={{ paddingTop: 72 }}>
          <span className="eyebrow">SYSTEM · SETTINGS</span>
          <h1 className="settings-title gradient-text">Settings</h1>
          <p className="settings-sub">
            Routing, voice, modules, system
            {coreVersion !== null && (
              <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em" }}>
                · core api v{coreVersion}
              </span>
            )}
          </p>
        </header>
        <div className="settings-rule" />

        {/* ── Error banner ────────────────────────────────────── */}
        {error && (
          <div className="settings-error-banner">
            <span className="settings-error-banner-msg">{error}</span>
            <button className="settings-error-banner-dismiss" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════
            SECTION: ROUTING
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Routing</div>

        {/* Default model */}
        <div className="settings-card hud">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Cpu strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">DEFAULT MODEL</span>
              <h2 className="settings-card-title">Routing</h2>
            </div>
            {saved && (
              <span className="settings-card-aside">
                <span className="tag on" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>saved ✓</span>
              </span>
            )}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              What Spectre routes to when you don&apos;t pick. Auto lets the router choose the best
              model per message.
            </p>
            <div className="settings-select-list">
              {/* Auto-route */}
              <button
                type="button"
                className={`settings-select-row tap-press${autoActive ? " active" : ""}`}
                onClick={() => saveDefault("")}
              >
                <span className="settings-select-inner">
                  <Sparkles
                    strokeWidth={1.6}
                    size={16}
                    style={{ color: "var(--color-accent-hover)", flexShrink: 0 }}
                  />
                  <span className="settings-select-text">
                    <span className="settings-select-label">Auto-route</span>
                    <span className="settings-select-hint">RECOMMENDED · ROUTER PICKS PER MESSAGE</span>
                  </span>
                </span>
                {autoActive && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
              </button>

              {/* Model rows */}
              {models.map((m) => {
                const active = defaultModel === m.id;
                const unavailable = m.available === false;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`settings-select-row tap-press${active ? " active" : ""}${unavailable ? " model-unavailable" : ""}`}
                    onClick={unavailable ? undefined : () => saveDefault(m.id)}
                    disabled={unavailable}
                    title={unavailable ? (m.unavailableReason ?? "Unavailable") : undefined}
                  >
                    <span className="settings-select-inner">
                      <span className="settings-select-text">
                        <span className="settings-select-label">{m.displayName}</span>
                        <span className="settings-select-hint">
                          {m.provider}
                          {unavailable && m.unavailableReason && (
                            <span className="settings-unavail-note"> · {m.unavailableReason}</span>
                          )}
                        </span>
                      </span>
                    </span>
                    {active && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: COMPOSITION
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Composition</div>

        <div className="settings-card hud">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <GitBranch strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">COMPOSITION</span>
              <h2 className="settings-card-title">AI Composition</h2>
            </div>
            {compSaved && (
              <span className="settings-card-aside">
                <span className="tag on" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>saved ✓</span>
              </span>
            )}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Configure which model thinks and which specialists it can hand work to.
            </p>

            {/* ── BRAIN ─────────────────────────────────────────── */}
            <div className="settings-comp-sub-label">Brain</div>
            <p className="settings-card-hint" style={{ marginBottom: 8 }}>
              The model that thinks. Auto lets the router pick per message.
            </p>
            <div className="settings-select-list" style={{ marginBottom: 20 }}>
              <button
                type="button"
                className={`settings-select-row tap-press${autoActive ? " active" : ""}`}
                onClick={() => saveDefault("")}
              >
                <span className="settings-select-inner">
                  <Sparkles
                    strokeWidth={1.6}
                    size={16}
                    style={{ color: "var(--color-accent-hover)", flexShrink: 0 }}
                  />
                  <span className="settings-select-text">
                    <span className="settings-select-label">Auto · route by intent</span>
                    <span className="settings-select-hint">RECOMMENDED · ROUTER PICKS PER MESSAGE</span>
                  </span>
                </span>
                {autoActive && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
              </button>
              {models.map((m) => {
                const active = defaultModel === m.id;
                const unavailable = m.available === false;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`settings-select-row tap-press${active ? " active" : ""}${unavailable ? " model-unavailable" : ""}`}
                    onClick={unavailable ? undefined : () => saveDefault(m.id)}
                    disabled={unavailable}
                    title={unavailable ? (m.unavailableReason ?? "Unavailable") : undefined}
                  >
                    <span className="settings-select-inner">
                      <span className="settings-select-text">
                        <span className="settings-select-label">{m.displayName}</span>
                        <span className="settings-select-hint">
                          {m.provider}
                          {unavailable && m.unavailableReason && (
                            <span className="settings-unavail-note"> · {m.unavailableReason}</span>
                          )}
                        </span>
                      </span>
                    </span>
                    {active && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>

            {/* ── REASONING EFFORT ──────────────────────────────── */}
            {brainModel?.reasoning && brainModel.effortLevels && brainModel.effortLevels.length > 0 && (
              <div className="settings-effort-block">
                <div className="settings-comp-sub-label">Reasoning effort</div>
                <div className="settings-effort-pills">
                  <button
                    type="button"
                    className={`settings-effort-pill${reasoningEffort === "" ? " active" : ""}`}
                    onClick={() => saveReasoningEffort("")}
                    title="Model default"
                  >
                    default
                  </button>
                  {brainModel.effortLevels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`settings-effort-pill${reasoningEffort === level ? " active" : ""}`}
                      onClick={() => saveReasoningEffort(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── ORCHESTRATE toggle ───────────────────────────── */}
            <div className="settings-comp-control-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Let the brain orchestrate other models</div>
                <div className="settings-row-hint">the brain can hand sub-tasks to specialist CLI/API models</div>
              </div>
              <button
                type="button"
                className={`settings-btn${orchestrate ? " on" : ""} tap-press`}
                onClick={() => saveOrchestrate(!orchestrate)}
              >
                {orchestrate ? "On" : "Off"}
              </button>
            </div>

            {/* ── ORCHESTRATION TARGETS ────────────────────────── */}
            {orchestrate && (
              <div className="settings-comp-targets">
                <div className="settings-comp-sub-label" style={{ marginTop: 16 }}>
                  Orchestration targets
                  <span className="settings-comp-targets-hint">
                    {orchTargets.length === 0 ? "(none selected = all available)" : `${orchTargets.length} selected`}
                  </span>
                </div>
                {specialistGroups.map(([provider, list]) => (
                  <div key={provider} className="settings-comp-vendor-group">
                    <div className="settings-provider-label">
                      {VENDOR_LABELS[provider] ?? provider}
                    </div>
                    <div className="settings-select-list">
                      {list.map((s) => {
                        const checked = orchTargets.includes(s.id);
                        const unavailable = "available" in s && s.available === false;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={`settings-select-row tap-press${checked ? " active" : ""}${unavailable ? " model-unavailable" : ""}`}
                            onClick={unavailable ? undefined : () => toggleTarget(s.id)}
                            disabled={unavailable}
                            title={unavailable ? ((s as Model).unavailableReason ?? "Unavailable") : undefined}
                          >
                            <span className="settings-select-inner">
                              <span className="settings-select-text">
                                <span className="settings-select-label">{s.displayName}</span>
                                <span className="settings-select-hint">
                                  {s.id}
                                  {unavailable && (s as Model).unavailableReason && (
                                    <span className="settings-unavail-note"> · {(s as Model).unavailableReason}</span>
                                  )}
                                </span>
                              </span>
                            </span>
                            {checked && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: INTERFACE
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Interface</div>

        {/* Opening modules */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <AppWindow strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">BLOB</span>
              <h2 className="settings-card-title">Opening modules</h2>
            </div>
            {ovCount > 0 && (
              <span className="settings-card-aside">
                <button
                  type="button"
                  className="settings-btn"
                  style={{ height: 28, fontSize: 11, padding: "0 9px" }}
                  onClick={() => {
                    clearOverrides();
                    setOvCount(0);
                  }}
                >
                  clear {ovCount} saved
                </button>
              </span>
            )}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              What happens when you click a module in the blob. &ldquo;Ask&rdquo; lets you choose per
              click and optionally remember it for that module.
            </p>
            <div className="settings-select-list">
              {OPEN_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`settings-select-row tap-press${openMode === o.value ? " active" : ""}`}
                  onClick={() => pickOpen(o.value)}
                >
                  <span className="settings-select-text">
                    <span className="settings-select-label">{o.label}</span>
                    <span className="settings-select-hint">{o.hint}</span>
                  </span>
                  {openMode === o.value && (
                    <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: AUTONOMY
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Autonomy</div>

        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <ShieldCheck strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">AUTONOMY</span>
              <h2 className="settings-card-title">How much Spectre acts on its own</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Governs whether Spectre asks before acting — self-improving its skills, applying workshop
              changes, running background work. Set it loose, or keep it on a leash.
            </p>
            <div className="settings-select-list">
              {APPROVAL_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`settings-select-row tap-press${approval === o.value ? " active" : ""}`}
                  onClick={() => pickApproval(o.value)}
                >
                  <span className="settings-select-text">
                    <span className="settings-select-label">{o.label}</span>
                    <span className="settings-select-hint">{o.hint}</span>
                  </span>
                  {approval === o.value && (
                    <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: INTEGRATIONS
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Integrations</div>

        {/* Microsoft 365 */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <CalendarDays strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">CALENDAR</span>
              <h2 className="settings-card-title">Microsoft 365</h2>
            </div>
            {ms?.connected && (
              <span className="settings-card-aside">
                <span className="tag on" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>connected ✓</span>
              </span>
            )}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Connect your Microsoft 365 account so Spectre can read your calendar (
              <span className="settings-inline-code">calendar.today</span> /{" "}
              <span className="settings-inline-code">calendar.upcoming</span>). Requires{" "}
              <span className="settings-inline-code">MS_GRAPH_CLIENT_ID</span> /{" "}
              <span className="settings-inline-code">SECRET</span> /{" "}
              <span className="settings-inline-code">REDIRECT_URI</span> set in the core.
            </p>

            {msLoading ? (
              <div className="settings-ms-loading">
                <span className="settings-spinner sm" />
                Checking…
              </div>
            ) : ms?.connected ? (
              <div className="settings-row" style={{ borderTop: "none", paddingTop: 0 }}>
                <div className="settings-row-text">
                  <div className="settings-row-label">{ms.user_name || ms.user_email || "Connected account"}</div>
                  {ms.user_email && (
                    <div className="settings-row-hint">{ms.user_email}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="settings-btn danger"
                  disabled={msDisconnecting}
                  onClick={disconnectMs}
                >
                  {msDisconnecting ? <span className="settings-spinner sm" /> : <CalendarDays size={14} />}
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="settings-btn accent"
                onClick={() => { window.location.href = "/api/auth/ms-graph/login"; }}
              >
                <CalendarDays size={14} />
                Connect Microsoft 365
              </button>
            )}

            {msNote && (
              <span
                className="settings-ms-note"
                style={{ color: msNote.ok ? "var(--color-accent-hover)" : "var(--color-error)" }}
              >
                {msNote.text}
              </span>
            )}
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: PROVIDERS
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Providers</div>

        {/* Detected providers */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Box strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">DETECTED</span>
              <h2 className="settings-card-title">Providers</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Providers Spectre detected. The standard brain runs through your gateway (
              <span className="settings-inline-code">litellm</span>) with your own keys/models.
              The Claude / Codex / Gemini CLIs run on your own subscription and are off by
              default — enable them below, or with the <span className="settings-inline-code">SPECTRE_ALLOW_*_CLI</span> flags.
            </p>
            <div className="settings-chip-row">
              {providers.length ? (
                providers.map((p) => (
                  <span key={p} className="tag">
                    {p}
                  </span>
                ))
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>—</span>
              )}
            </div>
          </div>
        </div>

        {/* CLI providers (Claude / Codex / Gemini) */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Terminal strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">SUBSCRIPTION CLIs</span>
              <h2 className="settings-card-title">CLI providers</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Run the Claude / Codex / Gemini CLIs locally on this machine, each on
              your own subscription — no API key. Turning one on takes effect
              immediately. Use at your own risk: depending on the vendor this may be
              against their terms and could flag your account — that&apos;s part of why
              they&apos;re off by default.
              {cli && !cli.uiAllowed && (
                <>
                  {" "}Toggling from here needs{" "}
                  <span className="settings-inline-code">SPECTRE_ALLOW_CLI_UI=1</span>{" "}
                  on the core; otherwise set each CLI&apos;s env var and restart.
                </>
              )}
            </p>
            {!cli ? (
              <span className="muted" style={{ fontSize: 13 }}>Checking…</span>
            ) : (
              <div className="settings-select-list">
                {cli.items.map((it) => {
                  const locked = !it.canManage;
                  return (
                    <div key={it.id} className="settings-row">
                      <div className="settings-row-text">
                        <div
                          className="settings-row-label"
                          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 99,
                              background: it.binaryOnPath ? "#4ade80" : "var(--color-text-muted)",
                              boxShadow: it.binaryOnPath ? "0 0 8px rgba(74,222,128,.6)" : "none",
                            }}
                          />
                          {it.label}
                        </div>
                        <div className="settings-row-hint">
                          {it.binaryOnPath ? "on PATH" : "not found on PATH"}
                          {locked && cli.uiAllowed === false && ` · or set ${it.envVar}=1`}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`settings-btn${it.enabled ? " on" : ""} tap-press`}
                        onClick={() => toggleCli(it.id, !it.enabled)}
                        disabled={locked || cliBusy === it.id}
                        title={
                          locked
                            ? "Set SPECTRE_ALLOW_CLI_UI=1 on the core to manage CLIs from here"
                            : undefined
                        }
                      >
                        {it.enabled ? "On" : "Off"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {cliMsg && (
              <span className={`settings-form-msg ${cliMsg.ok ? "ok" : "err"}`}>{cliMsg.text}</span>
            )}
          </div>
        </div>

        {/* Add a provider */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Plus strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">GATEWAY</span>
              <h2 className="settings-card-title">Add a provider</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Register a model on your LiteLLM gateway at runtime — it appears in Routing above
              automatically. Needs a LiteLLM proxy with a master key; a plain Ollama gateway has
              no admin API, so add those in{" "}
              <span className="settings-inline-code">litellm-config.yaml</span> and restart.
            </p>
            <div className="settings-form">
              <FieldInput
                label="Name"
                hint="WHAT SPECTRE REQUESTS · e.g. spectre-pro"
                value={addName}
                onChange={setAddName}
              />
              <FieldInput
                label="Model id"
                hint="PROVIDER-PREFIXED · e.g. anthropic/claude-sonnet-4-6"
                value={addModel}
                onChange={setAddModel}
              />
              <FieldInput
                label="API key"
                hint="OPTIONAL · YOUR PROVIDER KEY"
                value={addKey}
                onChange={setAddKey}
                type="password"
              />
              <FieldInput
                label="API base"
                hint="OPTIONAL · CUSTOM ENDPOINT URL"
                value={addBase}
                onChange={setAddBase}
              />
              <button
                type="button"
                className="settings-btn accent tap-press"
                style={{ alignSelf: "flex-start", marginTop: 2, height: 40, padding: "0 18px" }}
                onClick={addProviderModel}
                disabled={adding}
              >
                {adding ? <span className="settings-spinner sm" style={{ borderTopColor: "#fff" }} /> : null}
                {adding ? "Adding…" : "Add to gateway"}
              </button>
              {addMsg && (
                <span className={`settings-form-msg ${addMsg.ok ? "ok" : "err"}`}>
                  {addMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════
            SECTION: MODELS
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Models</div>

        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Brain strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">{models.filter(m => m.available !== false).length}/{models.length} AVAILABLE</span>
              <h2 className="settings-card-title">Models</h2>
            </div>
          </div>
          <div className="settings-card-body">
            {grouped.length ? (
              <div className="settings-models-groups">
                {grouped.map(([provider, list]) => (
                  <div key={provider} className="settings-models-group">
                    <div className="settings-provider-label">
                      {provider} · {list.length}
                    </div>
                    {list.map((m) => {
                      const unavailable = m.available === false;
                      return (
                        <div key={m.id} className={`settings-row${unavailable ? " model-row-unavailable" : ""}`}>
                          <div className="settings-row-text">
                            <div className="settings-row-label" style={unavailable ? { color: "var(--color-text-muted)" } : undefined}>
                              {m.displayName}
                            </div>
                            {unavailable && m.unavailableReason && (
                              <div className="settings-row-hint">{m.unavailableReason}</div>
                            )}
                          </div>
                          <span className={`settings-row-value${unavailable ? " warn" : ""}`}>
                            {unavailable ? "unavailable" : m.provider}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>—</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FieldInput({
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
    <label htmlFor={id} className="settings-field">
      <span className="settings-field-label">
        <span className="settings-field-name">{label}</span>
        <span className="settings-field-hint">{hint}</span>
      </span>
      <input
        id={id}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        spellCheck={false}
        autoComplete="off"
        className="settings-input"
      />
    </label>
  );
}
