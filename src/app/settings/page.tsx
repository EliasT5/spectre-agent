"use client";

import "./settings.css";

import { useEffect, useMemo, useState, useId, type ReactNode } from "react";
import { SpectreBackButton } from "@/components/SpectreBackButton";
import {
  Cpu,
  Brain,
  Check,
  Sparkles,
  AppWindow,
  ShieldCheck,
  Plus,
  CalendarDays,
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
  hasToken?: boolean;
  added?: boolean;
  hasBin?: boolean;
  bin?: string;
};
type CliState = { uiAllowed: boolean; items: CliRow[] };
type BackendRow = {
  id: string;
  kind: "api" | "cli-server" | "cli-command";
  label: string;
  enabled: boolean;
  roles?: { brain?: boolean; dispatch?: boolean };
  endpointType?: string;
  modelName?: string;
  command?: string;
  server?: { status?: string; port?: number; error?: string };
};

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
  const [models, setModels] = useState<Model[]>([]);
  const [coreVersion, setCoreVersion] = useState<number | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [openMode, setOpenMode] = useState<OpenDefault>("ask");
  const [ovCount, setOvCount] = useState(0);
  const [approval, setApproval] = useState<string>("balanced");
  const [error, setError] = useState<string | null>(null);

  // Orchestration
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

  // Subscription CLIs (Claude/Codex/Gemini) — runtime enable, gated by the
  // core's SPECTRE_ALLOW_CLI_UI master flag.
  const [cli, setCli] = useState<CliState | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [cliMsg, setCliMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cliTokenDraft, setCliTokenDraft] = useState<Record<string, string>>({});
  const [cliBinDraft, setCliBinDraft] = useState<Record<string, string>>({});

  // Model backends (unified: api / cli-server / cli-command)
  const [bkKind, setBkKind] = useState<"api" | "cli-server" | "cli-command">("api");
  const [bkLabel, setBkLabel] = useState("");
  const [bkEndpointType, setBkEndpointType] = useState("openai-compatible");
  const [bkModel, setBkModel] = useState("");
  const [bkKey, setBkKey] = useState("");
  const [bkBase, setBkBase] = useState("");
  const [bkApiVersion, setBkApiVersion] = useState("");
  const [bkCommand, setBkCommand] = useState("");
  const [bkArgs, setBkArgs] = useState("");
  const [bkServedModel, setBkServedModel] = useState("");
  const [bkPort, setBkPort] = useState("");
  const [bkPromptMode, setBkPromptMode] = useState("stdin");
  const [bkPromptFlag, setBkPromptFlag] = useState("");
  const [bkRoleBrain, setBkRoleBrain] = useState(true);
  const [bkRoleDispatch, setBkRoleDispatch] = useState(true);
  const [bkBusy, setBkBusy] = useState<null | "test" | "save">(null);
  const [bkMsg, setBkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [backends, setBackends] = useState<BackendRow[]>([]);
  const [bkUiAllowed, setBkUiAllowed] = useState(true);
  const [bkRowBusy, setBkRowBusy] = useState<string | null>(null);

  // User-defined model display-name overrides (Models → rename)
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});

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
    const r = await fetch("/api/models");
    if (r.ok) {
      const m = await r.json();
      setModels(m.models ?? []);
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

  async function saveCliToken(id: string, token: string) {
    setCliBusy(id);
    setCliMsg(null);
    try {
      const r = await fetch("/api/providers/cli/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, token }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setCli(j as CliState);
        setCliTokenDraft((d) => ({ ...d, [id]: "" }));
        setCliMsg({ ok: true, text: token.trim() ? "Token saved." : "Token cleared." });
      } else {
        setCliMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setCliMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setCliBusy(null);
    }
  }

  async function saveCliBin(id: string, bin: string) {
    setCliBusy(id);
    setCliMsg(null);
    try {
      const r = await fetch("/api/providers/cli/bin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, bin }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setCli(j as CliState);
        setCliBinDraft((d) => ({ ...d, [id]: "" }));
        setCliMsg({ ok: true, text: bin.trim() ? "Binary path saved." : "Binary path cleared." });
      } else {
        setCliMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setCliMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setCliBusy(null);
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
        // Model availability derives from the same gate.
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

  // ── Model backends ──────────────────────────────────────────────────────────
  function slugify(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  }

  async function loadBackends() {
    try {
      const r = await fetch("/api/providers/backends");
      if (r.ok) {
        const j = await r.json();
        setBackends(j.backends ?? []);
        setBkUiAllowed(j.uiAllowed !== false);
      }
    } catch {
      /* fail-soft — the card just won't list rows */
    }
  }

  function buildBackendBody(dryRun: boolean): Record<string, unknown> | null {
    const label = bkLabel.trim();
    if (!label) { setBkMsg({ ok: false, text: "Label is required." }); return null; }
    const id = slugify(label);
    if (!id) { setBkMsg({ ok: false, text: "Label must contain letters or digits." }); return null; }
    const args = bkArgs.trim() ? bkArgs.trim().split(/\s+/) : [];
    const base: Record<string, unknown> = { schemaVersion: 1, id, label, kind: bkKind, dryRun };
    if (bkKind === "api") {
      if (!bkModel.trim()) { setBkMsg({ ok: false, text: "Model id is required." }); return null; }
      base.endpointType = bkEndpointType;
      base.providerModel = bkModel.trim();
      if (bkKey.trim()) base.apiKey = bkKey.trim();
      if (bkBase.trim()) base.apiBase = bkBase.trim();
      if (bkApiVersion.trim()) base.apiVersion = bkApiVersion.trim();
    } else if (bkKind === "cli-server") {
      if (!bkCommand.trim()) { setBkMsg({ ok: false, text: "Command is required." }); return null; }
      base.command = bkCommand.trim();
      base.args = args;
      if (bkServedModel.trim()) base.servedModelName = bkServedModel.trim();
      if (bkPort.trim()) base.port = Number(bkPort.trim());
      base.managed = false;
    } else {
      if (!bkCommand.trim()) { setBkMsg({ ok: false, text: "Command is required." }); return null; }
      base.command = bkCommand.trim();
      base.args = args;
      if (bkModel.trim()) base.model = bkModel.trim();
      base.promptMode = bkPromptMode;
      if (bkPromptFlag.trim()) base.promptFlag = bkPromptFlag.trim();
      base.roles = { brain: bkRoleBrain, dispatch: bkRoleDispatch };
    }
    return base;
  }

  async function submitBackend(dryRun: boolean) {
    const body = buildBackendBody(dryRun);
    if (!body) return;
    setBkBusy(dryRun ? "test" : "save");
    setBkMsg(null);
    try {
      const res = await fetch("/api/providers/backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: unknown };
      if (res.ok && j.ok !== false) {
        if (dryRun) {
          setBkMsg({ ok: true, text: `Test OK — ${typeof j.detail === "string" ? j.detail : "reachable"}.` });
        } else {
          setBkMsg({ ok: true, text: `Saved "${bkLabel.trim()}" — now in the picker.` });
          setBkLabel(""); setBkModel(""); setBkKey(""); setBkBase(""); setBkApiVersion("");
          setBkCommand(""); setBkArgs(""); setBkServedModel(""); setBkPort(""); setBkPromptFlag("");
          await loadBackends();
          await loadModels();
        }
      } else {
        const detail = j.detail ? ` — ${typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail)}` : "";
        setBkMsg({ ok: false, text: `${j.error || `Failed (HTTP ${res.status}).`}${detail}` });
      }
    } catch (e) {
      setBkMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setBkBusy(null);
    }
  }

  async function toggleBackend(id: string, enabled: boolean) {
    setBkRowBusy(id);
    try {
      const r = await fetch(`/api/providers/backends/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (r.ok) { await loadBackends(); await loadModels(); }
      else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setBkMsg({ ok: false, text: j.error || "Failed to toggle." });
      }
    } finally {
      setBkRowBusy(null);
    }
  }

  async function deleteBackend(id: string) {
    setBkRowBusy(id);
    try {
      const r = await fetch(`/api/providers/backends/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r.ok) { await loadBackends(); await loadModels(); }
    } finally {
      setBkRowBusy(null);
    }
  }

  // ── Model display-name overrides ────────────────────────────────────────────
  async function loadModelLabels() {
    try {
      const r = await fetch("/api/app-config/model_labels");
      if (!r.ok) return;
      const v = (await r.json()).value;
      const parsed = typeof v === "string" ? JSON.parse(v) : v;
      if (parsed && typeof parsed === "object") setModelLabels(parsed as Record<string, string>);
    } catch {
      /* fail-soft */
    }
  }

  async function saveModelName(id: string, raw: string) {
    const name = raw.trim();
    const next = { ...modelLabels };
    if (name) next[id] = name;
    else delete next[id];
    setModelLabels(next);
    try {
      await fetch("/api/app-config/model_labels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(next) }),
      });
      await loadModels();
    } catch {
      /* fail-soft */
    }
  }

  useEffect(() => {
    void (async () => {
      const [hRes, cRes, aRes, orchRes, targRes, effortRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/app-config/default_model"),
        fetch("/api/app-config/approval_mode"),
        fetch("/api/app-config/orchestrate"),
        fetch("/api/app-config/orchestration_targets"),
        fetch("/api/app-config/reasoning_effort"),
      ]);
      void loadModels();
      if (aRes.ok) {
        const v = (await aRes.json()).value;
        if (typeof v === "string") setApproval(v);
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
    void loadBackends();
    void loadModelLabels();
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

  // CLIs default to none: only rows the user added are listed; the rest get an
  // add button. Cores without the `added` flag list everything, as before.
  const cliAdded = cli?.items.filter((it) => it.added !== false) ?? [];
  const cliAddable = cli?.items.filter((it) => it.added === false) ?? [];

  return (
    <div className="settings-page">
      <SpectreBackButton />

      <div className="settings-col">
        {/* ── Header ─────────────────────────────────────────── */}
        <header className="settings-header" style={{ paddingTop: 72 }}>
          <span className="eyebrow">SYSTEM · SETTINGS</span>
          <h1 className="settings-title gradient-text">Settings</h1>
          <p className="settings-sub">
            Routing, models, integrations, system
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

        {/* Brain + effort + orchestration in one card */}
        <div className="settings-card hud">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Cpu strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">MODEL &amp; ORCHESTRATION</span>
              <h2 className="settings-card-title">Routing</h2>
            </div>
            {(saved || compSaved) && <SavedTag />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              The model that answers, and what it can hand work to.
            </p>

            {/* ── BRAIN ─────────────────────────────────────────── */}
            <div className="settings-comp-sub-label">Brain</div>
            <div className="settings-select-list" style={{ marginBottom: 20 }}>
              <SelectRow
                active={autoActive}
                onClick={() => saveDefault("")}
                icon={
                  <Sparkles
                    strokeWidth={1.6}
                    size={16}
                    style={{ color: "var(--color-accent-hover)", flexShrink: 0 }}
                  />
                }
                label="Auto-route"
                hint="RECOMMENDED · ROUTER PICKS PER MESSAGE"
              />
              {models.map((m) => {
                const unavailable = m.available === false;
                return (
                  <SelectRow
                    key={m.id}
                    active={defaultModel === m.id}
                    unavailable={unavailable}
                    onClick={() => saveDefault(m.id)}
                    title={unavailable ? (m.unavailableReason ?? "Unavailable") : undefined}
                    label={m.displayName}
                    hint={
                      <>
                        {m.provider}
                        {unavailable && m.unavailableReason && (
                          <span className="settings-unavail-note"> · {m.unavailableReason}</span>
                        )}
                      </>
                    }
                  />
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
                <div className="settings-row-label">Orchestrate other models</div>
                <div className="settings-row-hint">hand sub-tasks to specialist CLI/API models</div>
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
                        const unavailable = "available" in s && s.available === false;
                        return (
                          <SelectRow
                            key={s.id}
                            active={orchTargets.includes(s.id)}
                            unavailable={unavailable}
                            onClick={() => toggleTarget(s.id)}
                            title={unavailable ? ((s as Model).unavailableReason ?? "Unavailable") : undefined}
                            label={s.displayName}
                            hint={
                              <>
                                {s.id}
                                {unavailable && (s as Model).unavailableReason && (
                                  <span className="settings-unavail-note"> · {(s as Model).unavailableReason}</span>
                                )}
                              </>
                            }
                          />
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
              What clicking a module in the blob does. &ldquo;Ask&rdquo; prompts per click and can
              remember your choice per module.
            </p>
            <div className="settings-select-list">
              {OPEN_OPTIONS.map((o) => (
                <SelectRow
                  key={o.value}
                  active={openMode === o.value}
                  onClick={() => pickOpen(o.value)}
                  label={o.label}
                  hint={o.hint}
                />
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
              When Spectre asks before acting — self-improving skills, workshop changes, background work.
            </p>
            <div className="settings-select-list">
              {APPROVAL_OPTIONS.map((o) => (
                <SelectRow
                  key={o.value}
                  active={approval === o.value}
                  onClick={() => pickApproval(o.value)}
                  label={o.label}
                  hint={o.hint}
                />
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
            {ms?.connected && <SavedTag text="connected ✓" />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Lets Spectre read your calendar (
              <span className="settings-inline-code">calendar.today</span> /{" "}
              <span className="settings-inline-code">calendar.upcoming</span>). Needs{" "}
              <span className="settings-inline-code">MS_GRAPH_CLIENT_ID</span> /{" "}
              <span className="settings-inline-code">SECRET</span> /{" "}
              <span className="settings-inline-code">REDIRECT_URI</span> on the core.
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
            SECTION: MODELS
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Models</div>

        {/* Add a model (api / cli-server / cli-command) */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Plus strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">BACKENDS</span>
              <h2 className="settings-card-title">Add a model</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              <b>API</b> — key + endpoint, routed through LiteLLM. <b>CLI server</b> — command that
              serves an OpenAI-compatible API. <b>CLI command</b> — raw command used as a brain
              and/or dispatch tool. CLI kinds spawn commands on the core and need{" "}
              <span className="settings-inline-code">SPECTRE_ALLOW_CLI_BACKENDS=1</span>.
            </p>
            <div className="settings-form">
              <label className="settings-field">
                <span className="settings-field-label">
                  <span className="settings-field-name">Kind</span>
                </span>
                <select
                  className="settings-input"
                  value={bkKind}
                  onChange={(e) => setBkKind(e.target.value as "api" | "cli-server" | "cli-command")}
                >
                  <option value="api">API (key + endpoint → LiteLLM)</option>
                  <option value="cli-server">CLI server (OpenAI-compatible)</option>
                  <option value="cli-command">CLI command (raw command + flags)</option>
                </select>
              </label>
              <FieldInput label="Label" hint="DISPLAY NAME · e.g. MiniMax M2" value={bkLabel} onChange={setBkLabel} />

              {bkKind === "api" && (
                <>
                  <label className="settings-field">
                    <span className="settings-field-label">
                      <span className="settings-field-name">Endpoint type</span>
                      <span className="settings-field-hint">HOW LITELLM ROUTES IT</span>
                    </span>
                    <select className="settings-input" value={bkEndpointType} onChange={(e) => setBkEndpointType(e.target.value)}>
                      <option value="openai">openai</option>
                      <option value="anthropic">anthropic</option>
                      <option value="gemini">gemini</option>
                      <option value="azure">azure</option>
                      <option value="openai-compatible">openai-compatible</option>
                    </select>
                  </label>
                  <FieldInput label="Model id" hint="PROVIDER MODEL · e.g. MiniMax-M2" value={bkModel} onChange={setBkModel} />
                  <FieldInput label="API key" hint="YOUR PROVIDER KEY" value={bkKey} onChange={setBkKey} type="password" />
                  <FieldInput
                    label="API base"
                    hint={bkEndpointType === "azure" || bkEndpointType === "openai-compatible" ? "REQUIRED · e.g. https://api.minimax.io/v1" : "OPTIONAL · CUSTOM ENDPOINT URL"}
                    value={bkBase}
                    onChange={setBkBase}
                  />
                  {bkEndpointType === "azure" && (
                    <FieldInput label="API version" hint="AZURE ONLY" value={bkApiVersion} onChange={setBkApiVersion} />
                  )}
                </>
              )}

              {bkKind === "cli-server" && (
                <>
                  <FieldInput label="Command" hint="e.g. llama-server" value={bkCommand} onChange={setBkCommand} />
                  <FieldInput label="Args" hint="SPACE-SEPARATED · use {port}" value={bkArgs} onChange={setBkArgs} />
                  <FieldInput label="Served model name" hint="WHAT ITS /v1/models ADVERTISES" value={bkServedModel} onChange={setBkServedModel} />
                  <FieldInput label="Port" hint="LOOPBACK PORT THE SERVER LISTENS ON" value={bkPort} onChange={setBkPort} />
                  <p className="settings-card-hint">
                    In Docker, run the server on the host — the core registers it on LiteLLM at{" "}
                    <span className="settings-inline-code">host.docker.internal:&lt;port&gt;</span>.
                  </p>
                </>
              )}

              {bkKind === "cli-command" && (
                <>
                  <FieldInput label="Command" hint="e.g. claude" value={bkCommand} onChange={setBkCommand} />
                  <FieldInput label="Args" hint="SPACE-SEPARATED · use {model}" value={bkArgs} onChange={setBkArgs} />
                  <FieldInput label="Model flag value" hint="OPTIONAL · substituted for {model}" value={bkModel} onChange={setBkModel} />
                  <label className="settings-field">
                    <span className="settings-field-label">
                      <span className="settings-field-name">Prompt via</span>
                    </span>
                    <select className="settings-input" value={bkPromptMode} onChange={(e) => setBkPromptMode(e.target.value)}>
                      <option value="stdin">stdin</option>
                      <option value="arg">flag + arg</option>
                      <option value="positional">positional arg</option>
                    </select>
                  </label>
                  {bkPromptMode === "arg" && (
                    <FieldInput label="Prompt flag" hint="e.g. -p" value={bkPromptFlag} onChange={setBkPromptFlag} />
                  )}
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", padding: "4px 0" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input type="checkbox" checked={bkRoleBrain} onChange={(e) => setBkRoleBrain(e.target.checked)} />
                      Use as brain (chat directly)
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input type="checkbox" checked={bkRoleDispatch} onChange={(e) => setBkRoleDispatch(e.target.checked)} />
                      Use as dispatch tool
                    </label>
                  </div>
                </>
              )}

              {bkKind !== "api" && !bkUiAllowed && (
                <span className="settings-form-msg err">
                  CLI backends are disabled — set SPECTRE_ALLOW_CLI_BACKENDS=1 on the core.
                </span>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
                <button type="button" className="settings-btn tap-press" style={{ height: 40, padding: "0 16px" }} onClick={() => submitBackend(true)} disabled={bkBusy !== null}>
                  {bkBusy === "test" ? "Testing…" : "Test"}
                </button>
                <button type="button" className="settings-btn accent tap-press" style={{ height: 40, padding: "0 18px" }} onClick={() => submitBackend(false)} disabled={bkBusy !== null}>
                  {bkBusy === "save" ? "Saving…" : "Save backend"}
                </button>
              </div>
              {bkMsg && <span className={`settings-form-msg ${bkMsg.ok ? "ok" : "err"}`}>{bkMsg.text}</span>}
            </div>
          </div>
        </div>

        {/* Backends & CLIs — everything added, one list */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Terminal strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">{backends.length} REGISTERED</span>
              <h2 className="settings-card-title">Backends &amp; CLIs</h2>
            </div>
          </div>
          <div className="settings-card-body">
            {backends.length ? (
              backends.map((b) => {
                const roles = [b.roles?.brain ? "brain" : null, b.roles?.dispatch ? "dispatch" : null].filter(Boolean).join(" + ");
                const sub =
                  b.kind === "api"
                    ? `api · ${b.endpointType} · ${b.modelName}`
                    : b.kind === "cli-server"
                      ? `cli-server · ${b.command}${b.server?.status ? ` · ${b.server.status}` : ""}`
                      : `cli-command · ${b.command} · ${roles}`;
                return (
                  <div key={b.id} className="settings-row">
                    <div className="settings-row-text">
                      <div className="settings-row-label">{b.label}</div>
                      <div className="settings-row-hint">{sub}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <button
                        type="button"
                        className={`settings-btn ${b.enabled ? "on" : ""} tap-press`}
                        onClick={() => toggleBackend(b.id, !b.enabled)}
                        disabled={bkRowBusy === b.id}
                      >
                        {b.enabled ? "On" : "Off"}
                      </button>
                      <button type="button" className="settings-btn tap-press" onClick={() => deleteBackend(b.id)} disabled={bkRowBusy === b.id}>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>No backends yet — add one above.</span>
            )}

            {/* ── Subscription CLIs (Claude / Codex / Gemini) ──── */}
            <div className="settings-comp-sub-label" style={{ marginTop: 18 }}>Subscription CLIs</div>
            <p className="settings-card-hint">
              Vendor CLIs run locally on your subscription — no API key. May be against vendor
              terms, so they&apos;re off by default.
              {cli && !cli.uiAllowed && (
                <>
                  {" "}Managing them here needs{" "}
                  <span className="settings-inline-code">SPECTRE_ALLOW_CLI_UI=1</span>{" "}
                  on the core; otherwise set each CLI&apos;s env var and restart.
                </>
              )}
            </p>
            {!cli ? (
              <span className="muted" style={{ fontSize: 13 }}>Checking…</span>
            ) : (
              <>
                {cliAdded.length === 0 && (
                  <span className="muted" style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
                    No CLIs added.
                  </span>
                )}
                <div className="settings-select-list">
                  {cliAdded.map((it) => {
                    const locked = !it.canManage;
                    return (
                      <div key={it.id}>
                        <div className="settings-row">
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
                                  background: it.binaryOnPath || it.hasBin ? "#4ade80" : "var(--color-text-muted)",
                                  boxShadow: it.binaryOnPath || it.hasBin ? "0 0 8px rgba(74,222,128,.6)" : "none",
                                }}
                              />
                              {it.label}
                              {it.hasToken && <span style={{ fontSize: 11, color: "#4ade80" }}>· authenticated</span>}
                            </div>
                            <div className="settings-row-hint">
                              {it.hasBin && it.bin ? it.bin : it.binaryOnPath ? "on PATH" : "not found on PATH"}
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
                        {it.canManage && (
                          <>
                            {/* Auth token — set the CLI's credential from here (no file edit). */}
                            <div className="settings-cli-subrow">
                              <input
                                className="settings-input"
                                style={{ height: 32, fontSize: 12, flex: 1 }}
                                type="password"
                                spellCheck={false}
                                autoComplete="off"
                                placeholder={
                                  it.hasToken
                                    ? "Token set — paste a new one to replace"
                                    : it.id === "claude-code"
                                      ? "Paste token from `claude setup-token`"
                                      : `Paste ${it.label} auth token`
                                }
                                value={cliTokenDraft[it.id] ?? ""}
                                onChange={(e) => setCliTokenDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                                aria-label={`${it.label} auth token`}
                              />
                              <button
                                type="button"
                                className="settings-btn tap-press"
                                style={{ height: 32 }}
                                onClick={() => saveCliToken(it.id, cliTokenDraft[it.id] ?? "")}
                                disabled={cliBusy === it.id || !(cliTokenDraft[it.id] ?? "").trim()}
                              >
                                Save token
                              </button>
                              {it.hasToken && (
                                <button
                                  type="button"
                                  className="settings-btn tap-press"
                                  style={{ height: 32 }}
                                  onClick={() => saveCliToken(it.id, "")}
                                  disabled={cliBusy === it.id}
                                  title="Remove the stored token"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                            {/* Binary path — override PATH lookup. */}
                            <div className="settings-cli-subrow">
                              <input
                                className="settings-input"
                                style={{ height: 32, fontSize: 12, flex: 1 }}
                                type="text"
                                spellCheck={false}
                                autoComplete="off"
                                placeholder={it.hasBin && it.bin ? it.bin : "Binary path — blank uses PATH"}
                                value={cliBinDraft[it.id] ?? ""}
                                onChange={(e) => setCliBinDraft((d) => ({ ...d, [it.id]: e.target.value }))}
                                aria-label={`${it.label} binary path`}
                              />
                              <button
                                type="button"
                                className="settings-btn tap-press"
                                style={{ height: 32 }}
                                onClick={() => saveCliBin(it.id, cliBinDraft[it.id] ?? "")}
                                disabled={cliBusy === it.id || !(cliBinDraft[it.id] ?? "").trim()}
                              >
                                Save path
                              </button>
                              {it.hasBin && (
                                <button
                                  type="button"
                                  className="settings-btn tap-press"
                                  style={{ height: 32 }}
                                  onClick={() => saveCliBin(it.id, "")}
                                  disabled={cliBusy === it.id}
                                  title="Use PATH lookup"
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {cliAddable.length > 0 && (
                  <div className="settings-chip-row" style={{ marginTop: 8 }}>
                    {cliAddable.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        className="settings-btn tap-press"
                        style={{ height: 30, fontSize: 12 }}
                        onClick={() => toggleCli(it.id, true)}
                        disabled={!it.canManage || cliBusy === it.id}
                        title={
                          !it.canManage
                            ? "Set SPECTRE_ALLOW_CLI_UI=1 on the core to manage CLIs from here"
                            : undefined
                        }
                      >
                        <Plus size={13} />
                        {it.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {cliMsg && (
              <span className={`settings-form-msg ${cliMsg.ok ? "ok" : "err"}`}>{cliMsg.text}</span>
            )}
          </div>
        </div>

        {/* Models — everything Spectre can route to */}
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
            <p className="settings-card-hint">
              Everything Spectre can route to, grouped by provider. Edit a name to rename it in
              the picker; clear to reset.
            </p>
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
                          <div className="settings-row-text" style={{ flex: 1, minWidth: 0 }}>
                            <input
                              className="settings-input"
                              style={{ height: 32, fontSize: 13, opacity: unavailable ? 0.6 : 1 }}
                              value={nameDraft[m.id] ?? m.displayName}
                              onChange={(e) => setNameDraft((d) => ({ ...d, [m.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              onBlur={() => {
                                const v = nameDraft[m.id];
                                if (v !== undefined && v !== m.displayName) void saveModelName(m.id, v);
                              }}
                              spellCheck={false}
                              autoComplete="off"
                              aria-label={`Display name for ${m.id}`}
                              title={`id: ${m.id}`}
                            />
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

function SavedTag({ text = "saved ✓" }: { text?: string }) {
  return (
    <span className="settings-card-aside">
      <span className="tag on" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{text}</span>
    </span>
  );
}

function SelectRow({
  active,
  unavailable = false,
  onClick,
  title,
  label,
  hint,
  icon,
}: {
  active: boolean;
  unavailable?: boolean;
  onClick: () => void;
  title?: string;
  label: string;
  hint: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`settings-select-row tap-press${active ? " active" : ""}${unavailable ? " model-unavailable" : ""}`}
      onClick={unavailable ? undefined : onClick}
      disabled={unavailable}
      title={title}
    >
      <span className="settings-select-inner">
        {icon}
        <span className="settings-select-text">
          <span className="settings-select-label">{label}</span>
          <span className="settings-select-hint">{hint}</span>
        </span>
      </span>
      {active && <Check strokeWidth={2} size={17} style={{ color: "var(--color-accent-hover)", flexShrink: 0 }} />}
    </button>
  );
}

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
