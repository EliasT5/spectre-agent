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
  GitBranch,
  RefreshCw,
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
type ToolRow = {
  name: string;
  category?: string;
  description?: string;
};
type ModelCapability = {
  mode: "all" | "allow";
  tools?: string[];
};
type ModelCapabilityMap = Record<string, ModelCapability>;
type UpdateReminderMode = "ask" | "auto" | "off";
type UpdateTarget = "core" | "shell";
type TargetReminders = { mode: UpdateReminderMode; mutedUntil?: number };
type UpdateReminders = { core: TargetReminders; shell: TargetReminders };

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

const UPDATE_REMINDER_OPTIONS: { value: UpdateReminderMode; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "RECOMMENDED · OPENS A CHAT WHEN A NEW VERSION LANDS" },
  { value: "auto", label: "Auto", hint: "REMINDS AS AUTO-UPDATE · APPLYING RUNS ON THE HOST" },
  { value: "off", label: "Off", hint: "NO UPDATE REMINDERS" },
];

const MUTE_DAY_MS = 24 * 3600 * 1000;
const MUTE_WEEK_MS = 7 * MUTE_DAY_MS;

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
  const [capabilities, setCapabilities] = useState<ModelCapabilityMap>({});
  const [capModel, setCapModel] = useState("_default");
  const [mcpTools, setMcpTools] = useState<ToolRow[]>([]);

  // Reasoning effort (persisted to app_config.reasoning_effort)
  const [reasoningEffort, setReasoningEffort] = useState<string>("");

  // Microsoft 365 connection
  const [ms, setMs] = useState<{ connected: boolean; accounts?: Array<{ id: string; user_email?: string | null; user_name?: string | null }> } | null>(null);
  const [msNote, setMsNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [msLoading, setMsLoading] = useState(true);
  const [msDisconnecting, setMsDisconnecting] = useState("");
  const [msBusy, setMsBusy] = useState(false);
  const [msDevice, setMsDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [msAdvanced, setMsAdvanced] = useState(false);

  // Subscription CLIs (Claude/Codex/Gemini) — runtime enable, gated by the
  // core's SPECTRE_ALLOW_CLI_UI master flag.
  const [cli, setCli] = useState<CliState | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [cliMsg, setCliMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cliTokenDraft, setCliTokenDraft] = useState<Record<string, string>>({});
  const [cliBinDraft, setCliBinDraft] = useState<Record<string, string>>({});

  // GitHub token (runtime, from Settings) — powers the Workspace clone/push flow.
  const [ghHasToken, setGhHasToken] = useState(false);
  const [ghDraft, setGhDraft] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ghDevice, setGhDevice] = useState<{ userCode: string; verificationUri: string } | null>(null);

  // Danger Zone toggles.
  const [envAccess, setEnvAccess] = useState(false);
  const [envBusy, setEnvBusy] = useState(false);
  const [envMsg, setEnvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Runtime feature flags (also in the Danger Zone) — no .env edit needed.
  const [cliUi, setCliUi] = useState(false);
  const [cliBackends, setCliBackends] = useState(false);
  const [ffBusy, setFfBusy] = useState("");
  const [ffMsg, setFfMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Update reminders (Settings → Updates) — how Spectre nudges about new versions.
  const [updRem, setUpdRem] = useState<UpdateReminders | null>(null);
  const [updRemBusy, setUpdRemBusy] = useState(false);
  const [updRemMsg, setUpdRemMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // MS 365 app credentials (set in Settings, no .env).
  const [msForm, setMsForm] = useState({ clientId: "", clientSecret: "", tenantId: "", redirectUri: "" });
  const [msHasSecret, setMsHasSecret] = useState(false);
  const [msHasCreds, setMsHasCreds] = useState(false);
  const [msCredsBusy, setMsCredsBusy] = useState(false);
  const [msCredsMsg, setMsCredsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Google (calendar) — mirrors Microsoft: creds + a list of connected accounts.
  const [google, setGoogle] = useState<{ connected: boolean; accounts?: Array<{ id: string; user_email?: string | null; user_name?: string | null }> } | null>(null);
  const [googleLoading, setGoogleLoading] = useState(true);
  const [googleDisconnecting, setGoogleDisconnecting] = useState("");
  const [googleNote, setGoogleNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [googleForm, setGoogleForm] = useState({ clientId: "", clientSecret: "", redirectUri: "" });
  const [googleHasSecret, setGoogleHasSecret] = useState(false);
  const [googleHasCreds, setGoogleHasCreds] = useState(false);
  const [googleCredsBusy, setGoogleCredsBusy] = useState(false);
  const [googleCredsMsg, setGoogleCredsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Web push (VAPID) keys.
  const [vapidForm, setVapidForm] = useState({ subject: "", publicKey: "", privateKey: "" });
  const [vapidHasKeys, setVapidHasKeys] = useState(false);
  const [vapidBusy, setVapidBusy] = useState(false);
  const [vapidMsg, setVapidMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Messaging channels (Telegram / WhatsApp / Discord).
  const [ch, setCh] = useState({
    telegram: { botToken: "", webhookSecret: "", allowedSenderIds: "" },
    whatsapp: { token: "", phoneNumberId: "", verifyToken: "", appSecret: "", allowedSenderIds: "", graphVersion: "" },
    discord: { botToken: "", allowedSenderIds: "" },
  });
  const [chStatus, setChStatus] = useState<{
    telegram: { hasBotToken: boolean; hasWebhookSecret: boolean; allowedSenderIds: string };
    whatsapp: { hasToken: boolean; phoneNumberId: string; hasVerifyToken: boolean; hasAppSecret: boolean; allowedSenderIds: string; graphVersion: string };
    discord: { hasBotToken: boolean; allowedSenderIds: string };
  } | null>(null);
  const [chBusy, setChBusy] = useState("");
  const [chMsg, setChMsg] = useState<{ ok: boolean; text: string; which: string } | null>(null);

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

  // Friendly "+ Add a CLI" — registers ANY command as a brain (a cli-command
  // backend under the hood), so the CLI list isn't limited to the built-in 3.
  const [addCliOpen, setAddCliOpen] = useState(false);
  const [newCli, setNewCli] = useState({ label: "", command: "", args: "", envName: "", envValue: "" });
  const [newCliBusy, setNewCliBusy] = useState(false);
  const [newCliMsg, setNewCliMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  async function disconnectMs(id: string) {
    setMsDisconnecting(id);
    try {
      await fetch("/api/auth/ms-graph/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      setMsNote(null);
      await loadMs();
    } finally {
      setMsDisconnecting("");
    }
  }

  // One-click sign-in via Microsoft device code: start it, show the code, poll
  // until approved, then the account lands in the list.
  async function startMsLogin() {
    setMsBusy(true);
    setMsNote(null);
    setMsDevice(null);
    try {
      const r = await fetch("/api/auth/ms-graph/device/start", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsNote({ ok: false, text: (j as { error?: string }).error || "Couldn't start Microsoft sign-in." });
        setMsBusy(false);
        return;
      }
      const { sessionId, userCode, verificationUri, interval } = j as {
        sessionId: string; userCode: string; verificationUri: string; interval: number;
      };
      setMsDevice({ userCode, verificationUri });
      window.open(verificationUri, "_blank", "noopener");
      const delay = Math.max(3, interval || 5) * 1000;
      const poll = async () => {
        try {
          const pr = await fetch("/api/auth/ms-graph/device/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const pj = (await pr.json().catch(() => ({}))) as { status?: string; error?: string; email?: string };
          if (pj.status === "authorized") {
            setMsDevice(null);
            setMsBusy(false);
            setMsNote({ ok: true, text: pj.email ? `Connected ${pj.email}.` : "Microsoft connected." });
            await loadMs();
            return;
          }
          if (pj.status === "pending") { setTimeout(() => void poll(), delay); return; }
          setMsDevice(null);
          setMsBusy(false);
          setMsNote({ ok: false, text: pj.error ? `Microsoft sign-in failed: ${pj.error}` : "Sign-in expired — try again." });
        } catch (e) {
          setMsDevice(null);
          setMsBusy(false);
          setMsNote({ ok: false, text: e instanceof Error ? e.message : "Microsoft sign-in failed." });
        }
      };
      setTimeout(() => void poll(), delay);
    } catch (e) {
      setMsNote({ ok: false, text: e instanceof Error ? e.message : "Microsoft sign-in failed." });
      setMsBusy(false);
    }
  }

  async function loadGoogle() {
    setGoogleLoading(true);
    try {
      const r = await fetch("/api/auth/google/status");
      if (r.ok) setGoogle(await r.json());
      else setGoogle({ connected: false });
    } catch {
      setGoogle({ connected: false });
    } finally {
      setGoogleLoading(false);
    }
  }

  async function disconnectGoogle(id: string) {
    setGoogleDisconnecting(id);
    try {
      await fetch("/api/auth/google/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      setGoogleNote(null);
      await loadGoogle();
    } finally {
      setGoogleDisconnecting("");
    }
  }

  async function loadGoogleCreds() {
    try {
      const r = await fetch("/api/auth/google/creds");
      if (r.ok) {
        const j = (await r.json()) as { clientId?: string; redirectUri?: string; hasSecret?: boolean; hasCreds?: boolean };
        const defaultRedirect = typeof window !== "undefined" ? `${window.location.origin}/api/auth/google/callback` : "";
        setGoogleForm((f) => ({ ...f, clientId: j.clientId || "", redirectUri: j.redirectUri || defaultRedirect, clientSecret: "" }));
        setGoogleHasSecret(!!j.hasSecret);
        setGoogleHasCreds(!!j.hasCreds);
      }
    } catch { /* fail-soft */ }
  }
  async function saveGoogleCreds() {
    setGoogleCredsBusy(true);
    setGoogleCredsMsg(null);
    try {
      const r = await fetch("/api/auth/google/creds", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(googleForm) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setGoogleHasSecret(!!(j as { hasSecret?: boolean }).hasSecret);
        setGoogleHasCreds(!!(j as { hasCreds?: boolean }).hasCreds);
        setGoogleForm((f) => ({ ...f, clientSecret: "" }));
        setGoogleCredsMsg({ ok: true, text: "Saved." });
      } else {
        setGoogleCredsMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setGoogleCredsMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setGoogleCredsBusy(false);
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

  async function loadGithub() {
    try {
      const r = await fetch("/api/providers/github");
      if (r.ok) { const j = await r.json(); setGhHasToken(!!(j as { hasToken?: boolean }).hasToken); }
    } catch { /* fail-soft */ }
  }

  async function saveGithubToken(token: string) {
    setGhBusy(true);
    setGhMsg(null);
    try {
      const r = await fetch("/api/providers/github/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setGhHasToken(!!(j as { hasToken?: boolean }).hasToken);
        setGhDraft("");
        setGhMsg({ ok: true, text: token.trim() ? "Token saved." : "Token cleared." });
      } else {
        setGhMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setGhMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setGhBusy(false);
    }
  }

  // "Just login" — GitHub OAuth device flow. Start it, show the code, then poll
  // until the user authorizes on github.com; the core stores the granted token.
  async function startGithubLogin() {
    setGhBusy(true);
    setGhMsg(null);
    setGhDevice(null);
    try {
      const r = await fetch("/api/providers/github/device/start", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setGhMsg({ ok: false, text: (j as { error?: string }).error || "Couldn't start GitHub login." });
        setGhBusy(false);
        return;
      }
      const { sessionId, userCode, verificationUri, interval } = j as {
        sessionId: string; userCode: string; verificationUri: string; interval: number;
      };
      setGhDevice({ userCode, verificationUri });
      window.open(verificationUri, "_blank", "noopener");
      const delay = Math.max(3, interval || 5) * 1000;
      const poll = async () => {
        try {
          const pr = await fetch("/api/providers/github/device/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const pj = (await pr.json().catch(() => ({}))) as { status?: string; error?: string };
          if (pj.status === "authorized") {
            setGhHasToken(true);
            setGhDevice(null);
            setGhBusy(false);
            setGhMsg({ ok: true, text: "Signed in to GitHub." });
            return;
          }
          if (pj.status === "pending") { setTimeout(() => void poll(), delay); return; }
          setGhDevice(null);
          setGhBusy(false);
          setGhMsg({ ok: false, text: pj.error ? `GitHub login failed: ${pj.error}` : "GitHub login expired — try again." });
        } catch (e) {
          setGhDevice(null);
          setGhBusy(false);
          setGhMsg({ ok: false, text: e instanceof Error ? e.message : "GitHub login failed." });
        }
      };
      setTimeout(() => void poll(), delay);
    } catch (e) {
      setGhMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
      setGhBusy(false);
    }
  }

  async function loadDanger() {
    try {
      const r = await fetch("/api/danger");
      if (r.ok) {
        const j = (await r.json()) as { allowEnvAccess?: boolean; cliUi?: boolean; cliBackends?: boolean };
        setEnvAccess(!!j.allowEnvAccess);
        setCliUi(!!j.cliUi);
        setCliBackends(!!j.cliBackends);
      }
    } catch { /* fail-soft */ }
  }

  async function toggleFeatureFlag(key: "cliUi" | "cliBackends") {
    const next = key === "cliUi" ? !cliUi : !cliBackends;
    setFfBusy(key);
    setFfMsg(null);
    try {
      const r = await fetch("/api/danger", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setCliUi(!!(j as { cliUi?: boolean }).cliUi);
        setCliBackends(!!(j as { cliBackends?: boolean }).cliBackends);
        // Reload the CLI list — enabling CLI management changes what's manageable.
        void loadCli();
      } else {
        setFfMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setFfMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setFfBusy("");
    }
  }

  async function toggleEnvAccess() {
    const next = !envAccess;
    setEnvBusy(true);
    setEnvMsg(null);
    try {
      const r = await fetch("/api/danger", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowEnvAccess: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setEnvAccess(!!(j as { allowEnvAccess?: boolean }).allowEnvAccess);
        setEnvMsg({ ok: true, text: next ? "Agent .env access ALLOWED." : "Agent .env access blocked." });
      } else {
        setEnvMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setEnvMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setEnvBusy(false);
    }
  }

  async function loadUpdateReminders() {
    try {
      const r = await fetch("/api/update/reminders");
      if (r.ok) setUpdRem((await r.json()) as UpdateReminders);
    } catch { /* fail-soft — the card just shows nothing selected */ }
  }

  async function saveUpdateReminders(
    target: UpdateTarget,
    body: { mode?: UpdateReminderMode; muteForMs?: number },
  ) {
    setUpdRemBusy(true);
    setUpdRemMsg(null);
    try {
      const r = await fetch("/api/update/reminders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setUpdRem(j as UpdateReminders);
        setUpdRemMsg({ ok: true, text: "Saved." });
      } else {
        setUpdRemMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setUpdRemMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setUpdRemBusy(false);
    }
  }

  async function loadMsCreds() {
    try {
      const r = await fetch("/api/auth/ms-graph/creds");
      if (r.ok) {
        const j = (await r.json()) as { clientId?: string; tenantId?: string; redirectUri?: string; hasSecret?: boolean; hasCreds?: boolean };
        const defaultRedirect = typeof window !== "undefined" ? `${window.location.origin}/api/auth/ms-graph/callback` : "";
        setMsForm((f) => ({ ...f, clientId: j.clientId || "", tenantId: j.tenantId || "", redirectUri: j.redirectUri || defaultRedirect, clientSecret: "" }));
        setMsHasSecret(!!j.hasSecret);
        setMsHasCreds(!!j.hasCreds);
      }
    } catch { /* fail-soft */ }
  }
  async function saveMsCreds() {
    setMsCredsBusy(true);
    setMsCredsMsg(null);
    try {
      const r = await fetch("/api/auth/ms-graph/creds", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msForm) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setMsHasSecret(!!(j as { hasSecret?: boolean }).hasSecret);
        setMsHasCreds(!!(j as { hasCreds?: boolean }).hasCreds);
        setMsForm((f) => ({ ...f, clientSecret: "" }));
        setMsCredsMsg({ ok: true, text: "Saved." });
      } else {
        setMsCredsMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setMsCredsMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setMsCredsBusy(false);
    }
  }

  async function loadVapid() {
    try {
      const r = await fetch("/api/providers/vapid");
      if (r.ok) {
        const j = (await r.json()) as { hasKeys?: boolean; subject?: string; publicKey?: string };
        setVapidForm((f) => ({ ...f, subject: j.subject || "", publicKey: j.publicKey || "", privateKey: "" }));
        setVapidHasKeys(!!j.hasKeys);
      }
    } catch { /* fail-soft */ }
  }
  async function saveVapid() {
    setVapidBusy(true);
    setVapidMsg(null);
    try {
      const r = await fetch("/api/providers/vapid", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(vapidForm) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setVapidHasKeys(!!(j as { hasKeys?: boolean }).hasKeys);
        setVapidForm((f) => ({ ...f, privateKey: "" }));
        setVapidMsg({ ok: true, text: "Saved." });
      } else {
        setVapidMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setVapidMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setVapidBusy(false);
    }
  }
  async function genVapid() {
    setVapidBusy(true);
    setVapidMsg(null);
    try {
      const r = await fetch("/api/providers/vapid/generate", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setVapidHasKeys(!!(j as { hasKeys?: boolean }).hasKeys);
        setVapidForm((f) => ({ ...f, publicKey: (j as { publicKey?: string }).publicKey || f.publicKey, privateKey: "" }));
        setVapidMsg({ ok: true, text: "New keys made. Add a subject and Save." });
      } else {
        setVapidMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).` });
      }
    } catch (e) {
      setVapidMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setVapidBusy(false);
    }
  }

  async function loadChannels() {
    try {
      const r = await fetch("/api/providers/channels");
      if (r.ok) {
        const j = await r.json();
        setChStatus(j);
        setCh((c) => ({
          telegram: { ...c.telegram, allowedSenderIds: j.telegram?.allowedSenderIds || "" },
          whatsapp: { ...c.whatsapp, phoneNumberId: j.whatsapp?.phoneNumberId || "", allowedSenderIds: j.whatsapp?.allowedSenderIds || "", graphVersion: j.whatsapp?.graphVersion || "" },
          discord: { ...c.discord, allowedSenderIds: j.discord?.allowedSenderIds || "" },
        }));
      }
    } catch { /* fail-soft */ }
  }
  async function saveChannel(which: "telegram" | "whatsapp" | "discord") {
    setChBusy(which);
    setChMsg(null);
    try {
      const r = await fetch("/api/providers/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [which]: ch[which] }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setChStatus(j);
        setCh((c) => {
          const next = { ...c };
          if (which === "telegram") next.telegram = { ...c.telegram, botToken: "", webhookSecret: "" };
          if (which === "whatsapp") next.whatsapp = { ...c.whatsapp, token: "", verifyToken: "", appSecret: "" };
          if (which === "discord") next.discord = { ...c.discord, botToken: "" };
          return next;
        });
        setChMsg({ ok: true, text: "Saved. Applies within ~10s.", which });
      } else {
        setChMsg({ ok: false, text: (j as { error?: string }).error || `Failed (HTTP ${r.status}).`, which });
      }
    } catch (e) {
      setChMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed.", which });
    } finally {
      setChBusy("");
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

  async function addCustomCli() {
    const label = newCli.label.trim();
    const command = newCli.command.trim();
    if (!label || !command) { setNewCliMsg({ ok: false, text: "Name and command are both required." }); return; }
    const id = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-cli") + "-cli";
    const args = newCli.args.trim() ? newCli.args.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    if (newCli.envName.trim() && newCli.envValue.trim()) env[newCli.envName.trim()] = newCli.envValue.trim();
    const body: Record<string, unknown> = {
      schemaVersion: 1,
      id,
      label,
      kind: "cli-command",
      command,
      args,
      promptMode: "stdin",
      outputMode: "stdout",
      roles: { brain: true, dispatch: true },
    };
    if (Object.keys(env).length) body.env = env;
    setNewCliBusy(true);
    setNewCliMsg(null);
    try {
      const res = await fetch("/api/providers/backends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: unknown };
      if (res.ok && j.ok !== false) {
        setNewCliMsg({ ok: true, text: `Added "${label}" — it's now in the model picker.` });
        setNewCli({ label: "", command: "", args: "", envName: "", envValue: "" });
        setAddCliOpen(false);
        await loadBackends();
        await loadModels();
      } else {
        const detail = j.detail ? ` — ${typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail)}` : "";
        setNewCliMsg({ ok: false, text: `${j.error || `Failed (HTTP ${res.status}).`}${detail}` });
      }
    } catch (e) {
      setNewCliMsg({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    } finally {
      setNewCliBusy(false);
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

  async function loadModelCapabilities() {
    try {
      const r = await fetch("/api/app-config/model_capabilities");
      if (!r.ok) return;
      const v = (await r.json()).value;
      const parsed = typeof v === "string" ? JSON.parse(v) : v;
      if (parsed && typeof parsed === "object") setCapabilities(parsed as ModelCapabilityMap);
    } catch {
      /* fail-soft */
    }
  }

  async function loadMcpTools() {
    try {
      const r = await fetch("/api/mcp");
      if (!r.ok) return;
      const j = (await r.json()) as { servers?: Array<{ tools?: ToolRow[] }> };
      setMcpTools(j.servers?.[0]?.tools ?? []);
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
    void loadGithub();
    void loadDanger();
    void loadMsCreds();
    void loadVapid();
    void loadChannels();
    void loadUpdateReminders();
  }, []);

  useEffect(() => {
    void loadBackends();
    void loadModelLabels();
    void loadModelCapabilities();
    void loadMcpTools();
  }, []);

  useEffect(() => {
    void loadMs();
    void loadGoogle();
    void loadGoogleCreds();
    const q = new URLSearchParams(window.location.search);
    if (q.get("ms_connected")) setMsNote({ ok: true, text: "Microsoft 365 connected." });
    else if (q.get("ms_error")) setMsNote({ ok: false, text: q.get("ms_error") || "Connection failed." });
    if (q.get("google_connected")) setGoogleNote({ ok: true, text: "Google connected." });
    else if (q.get("google_error")) setGoogleNote({ ok: false, text: q.get("google_error") || "Connection failed." });
    if (q.has("ms_connected") || q.has("ms_error") || q.has("google_connected") || q.has("google_error")) {
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

  async function saveModelCapabilities(next: ModelCapabilityMap) {
    setCapabilities(next);
    try {
      await fetch("/api/app-config/model_capabilities", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: JSON.stringify(next) }),
      });
      flashCompSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save model capabilities.");
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

  function setCapabilityMode(key: string, mode: ModelCapability["mode"]) {
    const current = capabilities[key];
    const next: ModelCapabilityMap = {
      ...capabilities,
      [key]: mode === "all"
        ? { mode: "all" as const }
        : { mode: "allow" as const, tools: current?.tools ?? [] },
    };
    void saveModelCapabilities(next);
  }

  function toggleCapabilityTool(key: string, tool: string) {
    const current = capabilities[key];
    const selected = new Set(current?.tools ?? []);
    if (selected.has(tool)) selected.delete(tool);
    else selected.add(tool);
    const nextTools = mcpTools.map((t) => t.name).filter((name) => selected.has(name));
    const next: ModelCapabilityMap = {
      ...capabilities,
      [key]: { mode: "allow" as const, tools: nextTools },
    };
    void saveModelCapabilities(next);
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

  const toolGroups = useMemo(() => {
    const map = new Map<string, ToolRow[]>();
    for (const t of mcpTools) {
      const category = t.category || "Other";
      const list = map.get(category) ?? [];
      list.push(t);
      map.set(category, list);
    }
    return Array.from(map.entries());
  }, [mcpTools]);

  const selectedCapability: ModelCapability = capabilities[capModel] ?? { mode: "all" };
  const selectedCapabilityTools = selectedCapability.tools ?? [];

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

        <div className="settings-card hud">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <ShieldCheck strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">PER-MODEL TOOLS</span>
              <h2 className="settings-card-title">Per-model capability</h2>
            </div>
            {compSaved && <SavedTag />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Choose which tools each model can use. Trimming the list keeps smaller local models
              fast and focused.
            </p>

            <div className="settings-comp-sub-label">Model</div>
            <select
              className="settings-input"
              value={capModel}
              onChange={(e) => setCapModel(e.target.value)}
              aria-label="Model capability target"
              style={{ marginBottom: 16 }}
            >
              <option value="_default">Default (all other models)</option>
              {grouped.map(([provider, list]) => (
                <optgroup key={provider} label={VENDOR_LABELS[provider] ?? provider}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <div className="settings-comp-sub-label">Mode</div>
            <div className="settings-select-list" style={{ marginBottom: 16 }}>
              <SelectRow
                active={selectedCapability.mode !== "allow"}
                onClick={() => setCapabilityMode(capModel, "all")}
                label="All tools"
                hint="UNRESTRICTED"
              />
              <SelectRow
                active={selectedCapability.mode === "allow"}
                onClick={() => setCapabilityMode(capModel, "allow")}
                label="Allow-listed"
                hint={`${selectedCapabilityTools.length} TOOL${selectedCapabilityTools.length === 1 ? "" : "S"}`}
              />
            </div>

            {selectedCapability.mode === "allow" && (
              <div className="settings-comp-targets">
                <div className="settings-comp-sub-label" style={{ marginTop: 16 }}>
                  Tools
                  <span className="settings-comp-targets-hint">
                    {selectedCapabilityTools.length} selected
                  </span>
                </div>
                {toolGroups.length ? (
                  toolGroups.map(([category, list]) => (
                    <div key={category} className="settings-comp-vendor-group">
                      <div className="settings-provider-label">{category}</div>
                      <div className="settings-select-list">
                        {list.map((tool) => (
                          <SelectRow
                            key={tool.name}
                            active={selectedCapabilityTools.includes(tool.name)}
                            onClick={() => toggleCapabilityTool(capModel, tool.name)}
                            label={tool.name}
                            hint={tool.description || tool.category || "Tool"}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>Checking tools...</span>
                )}
              </div>
            )}

            <p className="settings-card-hint" style={{ marginTop: 14, opacity: 0.75, fontSize: 11 }}>
              Grants apply on gateway tool-turns; restricting a model&apos;s tools also turns off its
              external MCP servers.
            </p>
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
            SECTION: DANGER ZONE — wrapped + pushed to the bottom of the page
            via CSS `order: 100` on .settings-danger-zone (settings-col is flex).
        ══════════════════════════════════════════════════════ */}
        <div className="settings-danger-zone">
          <div className="settings-danger-banner">
            <span aria-hidden style={{ fontSize: 18 }}>⚠</span>
            <span>
              <strong>Danger Zone</strong> — these settings affect security and can
              break things. Only change them if you understand what they do.
            </span>
          </div>

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

        {/* Agent access to .env secrets */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <ShieldCheck strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">SECRETS</span>
              <h2 className="settings-card-title">Agent access to .env files</h2>
            </div>
            {envAccess && <SavedTag text="allowed ⚠" />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              By default the agent can&apos;t read or edit{" "}
              <span className="settings-inline-code">.env</span> files — they hold your
              secrets. Turn this on only if you specifically need the agent to touch them.
            </p>
            <button
              type="button"
              className={`settings-btn ${envAccess ? "danger" : "accent"}`}
              style={{ alignSelf: "flex-start" }}
              onClick={() => void toggleEnvAccess()}
              disabled={envBusy}
            >
              <ShieldCheck size={14} /> {envAccess ? "Block .env access" : "Allow .env access"}
            </button>
            {envMsg && (
              <span className={`settings-form-msg ${envMsg.ok ? "ok" : "err"}`}>{envMsg.text}</span>
            )}
          </div>
        </div>

        {/* CLI features — runtime toggles, no .env edit */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <Terminal strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">CLI</span>
              <h2 className="settings-card-title">CLI features</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Turn CLI brains on without editing <span className="settings-inline-code">.env</span>.
              (Installing a CLI&apos;s binary still needs the image built with{" "}
              <span className="settings-inline-code">INSTALL_CLIS=1</span> — that part is build-time.)
            </p>

            <div className="settings-row" style={{ borderTop: "none", paddingTop: 0 }}>
              <div className="settings-row-text">
                <div className="settings-row-label">Manage CLI brains from Settings</div>
                <div className="settings-row-hint">Shows the Subscription CLIs section (Claude / Codex / Gemini) and lets you enable/authenticate them.</div>
              </div>
              <button
                type="button"
                className={`settings-btn ${cliUi ? "danger" : "accent"}`}
                onClick={() => void toggleFeatureFlag("cliUi")}
                disabled={ffBusy === "cliUi"}
              >
                {cliUi ? "On" : "Off"}
              </button>
            </div>

            <div className="settings-row" style={{ borderTop: "none", paddingTop: 0 }}>
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Custom CLI / command backends{" "}
                  <span style={{ color: "var(--color-error)", fontSize: 11 }}>⚠ runs commands</span>
                </div>
                <div className="settings-row-hint">Lets &quot;Add a CLI&quot; register any command as a brain. These spawn operator-supplied commands (RCE by design) — only turn on if you trust what you add.</div>
              </div>
              <button
                type="button"
                className={`settings-btn ${cliBackends ? "danger" : "accent"}`}
                onClick={() => void toggleFeatureFlag("cliBackends")}
                disabled={ffBusy === "cliBackends"}
              >
                {cliBackends ? "On" : "Off"}
              </button>
            </div>

            {ffMsg && <span className={`settings-form-msg ${ffMsg.ok ? "ok" : "err"}`}>{ffMsg.text}</span>}
          </div>
        </div>
        </div>{/* /settings-danger-zone */}

        {/* ══════════════════════════════════════════════════════
            SECTION: UPDATES
        ══════════════════════════════════════════════════════ */}
        <div className="settings-section-label">Updates</div>

        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <RefreshCw strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">SELF-UPDATE</span>
              <h2 className="settings-card-title">Update reminders</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              When a new Spectre version lands on GitHub, Spectre opens a chat to tell
              you. Core and shell update independently — applying runs on the host:{" "}
              <span className="settings-inline-code">scripts/spectre-update.sh --apply --target core|shell</span>.
            </p>

            <UpdateTargetRow
              target="core"
              title="Core"
              subtitle="the engine · auto recommended"
              settings={updRem?.core}
              busy={updRemBusy}
              onSave={(body) => void saveUpdateReminders("core", body)}
            />

            <UpdateTargetRow
              target="shell"
              title="Shell"
              subtitle="the app UI"
              settings={updRem?.shell}
              busy={updRemBusy}
              onSave={(body) => void saveUpdateReminders("shell", body)}
              warning={
                updRem?.shell?.mode === "auto"
                  ? "Overwrites shell files on update; your modules, /data extensions, and uncommitted work are NOT touched."
                  : undefined
              }
            />

            {updRemMsg && (
              <span className={`settings-form-msg ${updRemMsg.ok ? "ok" : "err"}`}>{updRemMsg.text}</span>
            )}
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
            {ms?.connected && <SavedTag text={`${ms.accounts?.length ?? 1} connected ✓`} />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Sign in with your Microsoft account to let Spectre read your calendar
              and email — no setup needed, works with personal and work accounts.
              Connect several to see them all together.
            </p>

            {msLoading ? (
              <div className="settings-ms-loading">
                <span className="settings-spinner sm" />
                Checking…
              </div>
            ) : (
              <>
                {(ms?.accounts ?? []).map((a) => (
                  <div key={a.id} className="settings-row" style={{ borderTop: "none", paddingTop: 0 }}>
                    <div className="settings-row-text">
                      <div className="settings-row-label">{a.user_name || a.user_email || "Connected account"}</div>
                      {a.user_email && <div className="settings-row-hint">{a.user_email}</div>}
                    </div>
                    <button
                      type="button"
                      className="settings-btn danger"
                      disabled={msDisconnecting === a.id}
                      onClick={() => void disconnectMs(a.id)}
                    >
                      {msDisconnecting === a.id ? <span className="settings-spinner sm" /> : <CalendarDays size={14} />}
                      Disconnect
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="settings-btn accent"
                  onClick={() => void startMsLogin()}
                  disabled={msBusy}
                >
                  <CalendarDays size={14} />
                  {msBusy ? "Waiting for Microsoft…" : (ms?.accounts?.length ?? 0) > 0 ? "Add another account" : "Sign in with Microsoft"}
                </button>
                {msDevice && (
                  <div
                    className="settings-card-hint"
                    style={{ padding: "8px 16px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, marginTop: 8 }}
                  >
                    Go to{" "}
                    <a href={msDevice.verificationUri} target="_blank" rel="noreferrer" className="settings-inline-code">
                      {msDevice.verificationUri.replace(/^https?:\/\//, "")}
                    </a>{" "}
                    and enter code{" "}
                    <span className="settings-inline-code" style={{ fontSize: 15, letterSpacing: 2 }}>{msDevice.userCode}</span>
                  </div>
                )}
              </>
            )}

            {msNote && (
              <span
                className="settings-ms-note"
                style={{ color: msNote.ok ? "var(--color-accent-hover)" : "var(--color-error)" }}
              >
                {msNote.text}
              </span>
            )}

            <button
              type="button"
              onClick={() => setMsAdvanced((v) => !v)}
              style={{ background: "none", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", padding: "10px 16px 0", textAlign: "left" }}
            >
              {msAdvanced ? "▴" : "▾"} Advanced — use your own Azure app instead
            </button>
            {msAdvanced && (
              <>
                <p className="settings-card-hint" style={{ opacity: 0.75, fontSize: 11 }}>
                  Optional. Your own app registration (needs{" "}
                  <span className="settings-inline-code">Calendars.Read</span> +{" "}
                  <span className="settings-inline-code">Mail.Read</span>). Its Client ID
                  is then used for sign-in too; a secret + redirect URI are only needed for
                  the browser-redirect connect.
                </p>
                <div className="settings-cli-subrow">
                  <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Client ID" value={msForm.clientId} onChange={(e) => setMsForm((f) => ({ ...f, clientId: e.target.value }))} spellCheck={false} />
                  <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off" placeholder={msHasSecret ? "Client secret — set (paste to replace)" : "Client secret"} value={msForm.clientSecret} onChange={(e) => setMsForm((f) => ({ ...f, clientSecret: e.target.value }))} spellCheck={false} />
                </div>
                <div className="settings-cli-subrow">
                  <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Tenant ID (default: common)" value={msForm.tenantId} onChange={(e) => setMsForm((f) => ({ ...f, tenantId: e.target.value }))} spellCheck={false} />
                  <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Redirect URI" value={msForm.redirectUri} onChange={(e) => setMsForm((f) => ({ ...f, redirectUri: e.target.value }))} spellCheck={false} />
                </div>
                <div className="settings-cli-subrow">
                  <button type="button" className="settings-btn tap-press" style={{ height: 32 }} onClick={() => void saveMsCreds()} disabled={msCredsBusy}>Save credentials</button>
                  {msHasCreds && <SavedTag text="credentials set ✓" />}
                  {msHasCreds && (
                    <button type="button" className="settings-btn" style={{ height: 32 }} onClick={() => { window.location.href = "/api/auth/ms-graph/login"; }}>Connect via redirect</button>
                  )}
                  {msCredsMsg && (
                    <span className={`settings-form-msg ${msCredsMsg.ok ? "ok" : "err"}`}>{msCredsMsg.text}</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Google (calendar) */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <CalendarDays strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">CALENDAR</span>
              <h2 className="settings-card-title">Google</h2>
            </div>
            {google?.connected && <SavedTag text={`${google.accounts?.length ?? 1} connected ✓`} />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Lets Spectre read your Google Calendar and Gmail. Create a Google Cloud
              OAuth app (scopes <span className="settings-inline-code">calendar.readonly</span>{" "}
              + <span className="settings-inline-code">gmail.readonly</span>), add its
              redirect URI, then paste the credentials below and connect.
            </p>

            <div className="settings-cli-subrow">
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="text"
                placeholder="Client ID"
                value={googleForm.clientId}
                onChange={(e) => setGoogleForm((f) => ({ ...f, clientId: e.target.value }))}
                spellCheck={false}
              />
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="password"
                autoComplete="off"
                placeholder={googleHasSecret ? "Client secret — set (paste to replace)" : "Client secret"}
                value={googleForm.clientSecret}
                onChange={(e) => setGoogleForm((f) => ({ ...f, clientSecret: e.target.value }))}
                spellCheck={false}
              />
            </div>
            <div className="settings-cli-subrow">
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="text"
                placeholder="Redirect URI"
                value={googleForm.redirectUri}
                onChange={(e) => setGoogleForm((f) => ({ ...f, redirectUri: e.target.value }))}
                spellCheck={false}
              />
              <button
                type="button"
                className="settings-btn tap-press"
                style={{ height: 32 }}
                onClick={() => void saveGoogleCreds()}
                disabled={googleCredsBusy}
              >
                Save credentials
              </button>
            </div>
            <div className="settings-cli-subrow">
              {googleHasCreds && <SavedTag text="credentials set ✓" />}
              {googleCredsMsg && (
                <span className={`settings-form-msg ${googleCredsMsg.ok ? "ok" : "err"}`}>{googleCredsMsg.text}</span>
              )}
            </div>

            {googleLoading ? (
              <div className="settings-ms-loading">
                <span className="settings-spinner sm" />
                Checking…
              </div>
            ) : (
              <>
                {(google?.accounts ?? []).map((a) => (
                  <div key={a.id} className="settings-row" style={{ borderTop: "none", paddingTop: 0 }}>
                    <div className="settings-row-text">
                      <div className="settings-row-label">{a.user_name || a.user_email || "Connected account"}</div>
                      {a.user_email && <div className="settings-row-hint">{a.user_email}</div>}
                    </div>
                    <button
                      type="button"
                      className="settings-btn danger"
                      disabled={googleDisconnecting === a.id}
                      onClick={() => void disconnectGoogle(a.id)}
                    >
                      {googleDisconnecting === a.id ? <span className="settings-spinner sm" /> : <CalendarDays size={14} />}
                      Disconnect
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="settings-btn accent"
                  disabled={!googleHasCreds}
                  title={googleHasCreds ? "" : "Save your app credentials first"}
                  onClick={() => { window.location.href = "/api/auth/google/login"; }}
                >
                  <CalendarDays size={14} />
                  {(google?.accounts?.length ?? 0) > 0 ? "Add another account" : "Connect Google"}
                </button>
              </>
            )}

            {googleNote && (
              <span
                className="settings-ms-note"
                style={{ color: googleNote.ok ? "var(--color-accent-hover)" : "var(--color-error)" }}
              >
                {googleNote.text}
              </span>
            )}
          </div>
        </div>

        {/* GitHub */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <GitBranch strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">GIT</span>
              <h2 className="settings-card-title">GitHub</h2>
            </div>
            {ghHasToken && <SavedTag text="connected ✓" />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Lets Workspaces clone repos (OPEN REPO) and push / open PRs. Use a
              fine-grained token with{" "}
              <span className="settings-inline-code">Contents: read &amp; write</span>, or a
              classic token with <span className="settings-inline-code">repo</span> scope.
              Stored on the core, never shown again.
            </p>

            {ghHasToken ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: "#4ade80", fontFamily: "var(--font-mono)", fontSize: 12 }}>✓ Signed in to GitHub</span>
                <button
                  type="button"
                  className="settings-btn danger"
                  style={{ height: 30, fontSize: 11, padding: "0 12px" }}
                  onClick={() => void saveGithubToken("")}
                  disabled={ghBusy}
                  title="Remove the stored token"
                >
                  Log out
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button
                    type="button"
                    className="settings-btn accent"
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => void startGithubLogin()}
                    disabled={ghBusy}
                  >
                    <GitBranch size={14} /> {ghDevice ? "Waiting for GitHub…" : "Login with GitHub"}
                  </button>
                  {ghDevice && (
                    <p className="settings-card-hint" style={{ margin: 0 }}>
                      Enter code{" "}
                      <span className="settings-inline-code" style={{ fontSize: 15, letterSpacing: 2 }}>{ghDevice.userCode}</span>{" "}
                      at{" "}
                      <a href={ghDevice.verificationUri} target="_blank" rel="noreferrer" className="settings-inline-code">
                        {ghDevice.verificationUri.replace(/^https?:\/\//, "")}
                      </a>{" "}
                      (opened in a new tab), then come back — it&apos;ll sign in automatically.
                    </p>
                  )}
                </div>

                <p className="settings-card-hint" style={{ margin: 0, opacity: 0.7, fontSize: 11 }}>or paste a token manually:</p>
                <div className="settings-cli-subrow">
                  <input
                    className="settings-input"
                    style={{ height: 32, fontSize: 12, flex: 1 }}
                    type="password"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Paste a GitHub token (ghp_… / github_pat_…)"
                    value={ghDraft}
                    onChange={(e) => setGhDraft(e.target.value)}
                    aria-label="GitHub token"
                  />
                  <button
                    type="button"
                    className="settings-btn tap-press"
                    style={{ height: 32 }}
                    onClick={() => void saveGithubToken(ghDraft)}
                    disabled={ghBusy || !ghDraft.trim()}
                  >
                    Save token
                  </button>
                </div>
              </>
            )}
            {ghMsg && (
              <span className={`settings-form-msg ${ghMsg.ok ? "ok" : "err"}`}>{ghMsg.text}</span>
            )}
          </div>
        </div>

        {/* Web push (VAPID) */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <ShieldCheck strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">NOTIFICATIONS</span>
              <h2 className="settings-card-title">Web push</h2>
            </div>
            {vapidHasKeys && <SavedTag text="keys set ✓" />}
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Push alerts to your devices. Click Generate keys, add a subject (a{" "}
              <span className="settings-inline-code">mailto:</span> address or URL),
              then Save. Making new keys forces devices to subscribe again.
            </p>

            <div className="settings-cli-subrow">
              <button
                type="button"
                className="settings-btn accent"
                style={{ height: 32 }}
                onClick={() => void genVapid()}
                disabled={vapidBusy}
              >
                Generate keys
              </button>
              {vapidHasKeys && (
                <span className="mono muted" style={{ fontSize: 11 }}>
                  public key set
                </span>
              )}
            </div>
            <div className="settings-cli-subrow">
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="text"
                placeholder="Subject (mailto:you@example.com)"
                value={vapidForm.subject}
                onChange={(e) => setVapidForm((f) => ({ ...f, subject: e.target.value }))}
                spellCheck={false}
              />
            </div>
            <div className="settings-cli-subrow">
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="text"
                placeholder="Public key (or use Generate)"
                value={vapidForm.publicKey}
                onChange={(e) => setVapidForm((f) => ({ ...f, publicKey: e.target.value }))}
                spellCheck={false}
              />
            </div>
            <div className="settings-cli-subrow">
              <input
                className="settings-input"
                style={{ height: 32, fontSize: 12, flex: 1 }}
                type="password"
                autoComplete="off"
                placeholder={vapidHasKeys ? "Private key — set (paste to replace)" : "Private key (or use Generate)"}
                value={vapidForm.privateKey}
                onChange={(e) => setVapidForm((f) => ({ ...f, privateKey: e.target.value }))}
                spellCheck={false}
              />
              <button
                type="button"
                className="settings-btn tap-press"
                style={{ height: 32 }}
                onClick={() => void saveVapid()}
                disabled={vapidBusy}
              >
                Save
              </button>
            </div>
            {vapidMsg && (
              <span className={`settings-form-msg ${vapidMsg.ok ? "ok" : "err"}`}>{vapidMsg.text}</span>
            )}
          </div>
        </div>

        {/* Messaging channels (Telegram / WhatsApp / Discord) */}
        <div className="settings-card">
          <div className="glass-fresnel" aria-hidden />
          <div className="settings-card-head">
            <span className="settings-icon-badge">
              <AppWindow strokeWidth={1.6} />
            </span>
            <div className="settings-card-titles">
              <span className="settings-card-eyebrow">MESSAGING</span>
              <h2 className="settings-card-title">Channels</h2>
            </div>
          </div>
          <div className="settings-card-body">
            <p className="settings-card-hint">
              Let people chat with Spectre from Telegram, WhatsApp, or Discord. Paste
              each bot&apos;s tokens, then list the sender IDs allowed to talk to it
              (comma-separated — empty means nobody). Changes apply within ~10s; no
              restart needed.
            </p>

            {/* Telegram */}
            <div className="settings-channel-block">
              <div className="settings-channel-head">
                <strong>Telegram</strong>
                {chStatus?.telegram.hasBotToken && <SavedTag text="token set ✓" />}
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.telegram.hasBotToken ? "Bot token — set (paste to replace)" : "Bot token"}
                  value={ch.telegram.botToken} onChange={(e) => setCh((c) => ({ ...c, telegram: { ...c.telegram, botToken: e.target.value } }))} spellCheck={false} />
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.telegram.hasWebhookSecret ? "Webhook secret — set" : "Webhook secret"}
                  value={ch.telegram.webhookSecret} onChange={(e) => setCh((c) => ({ ...c, telegram: { ...c.telegram, webhookSecret: e.target.value } }))} spellCheck={false} />
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text"
                  placeholder="Allowed sender IDs (comma-separated)"
                  value={ch.telegram.allowedSenderIds} onChange={(e) => setCh((c) => ({ ...c, telegram: { ...c.telegram, allowedSenderIds: e.target.value } }))} spellCheck={false} />
                <button type="button" className="settings-btn tap-press" style={{ height: 32 }} onClick={() => void saveChannel("telegram")} disabled={chBusy === "telegram"}>Save</button>
              </div>
              {chMsg?.which === "telegram" && <span className={`settings-form-msg ${chMsg.ok ? "ok" : "err"}`}>{chMsg.text}</span>}
            </div>

            {/* WhatsApp */}
            <div className="settings-channel-block">
              <div className="settings-channel-head">
                <strong>WhatsApp</strong>
                {chStatus?.whatsapp.hasToken && <SavedTag text="token set ✓" />}
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.whatsapp.hasToken ? "Access token — set (paste to replace)" : "Access token"}
                  value={ch.whatsapp.token} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, token: e.target.value } }))} spellCheck={false} />
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text"
                  placeholder="Phone number ID"
                  value={ch.whatsapp.phoneNumberId} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, phoneNumberId: e.target.value } }))} spellCheck={false} />
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.whatsapp.hasVerifyToken ? "Verify token — set" : "Verify token"}
                  value={ch.whatsapp.verifyToken} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, verifyToken: e.target.value } }))} spellCheck={false} />
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.whatsapp.hasAppSecret ? "App secret — set" : "App secret"}
                  value={ch.whatsapp.appSecret} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, appSecret: e.target.value } }))} spellCheck={false} />
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 2 }} type="text"
                  placeholder="Allowed sender IDs (comma-separated)"
                  value={ch.whatsapp.allowedSenderIds} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, allowedSenderIds: e.target.value } }))} spellCheck={false} />
                <input className="settings-input" style={{ height: 32, fontSize: 12, width: 110 }} type="text"
                  placeholder="Graph ver"
                  value={ch.whatsapp.graphVersion} onChange={(e) => setCh((c) => ({ ...c, whatsapp: { ...c.whatsapp, graphVersion: e.target.value } }))} spellCheck={false} />
                <button type="button" className="settings-btn tap-press" style={{ height: 32 }} onClick={() => void saveChannel("whatsapp")} disabled={chBusy === "whatsapp"}>Save</button>
              </div>
              {chMsg?.which === "whatsapp" && <span className={`settings-form-msg ${chMsg.ok ? "ok" : "err"}`}>{chMsg.text}</span>}
            </div>

            {/* Discord */}
            <div className="settings-channel-block">
              <div className="settings-channel-head">
                <strong>Discord</strong>
                {chStatus?.discord.hasBotToken && <SavedTag text="token set ✓" />}
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off"
                  placeholder={chStatus?.discord.hasBotToken ? "Bot token — set (paste to replace)" : "Bot token"}
                  value={ch.discord.botToken} onChange={(e) => setCh((c) => ({ ...c, discord: { ...c.discord, botToken: e.target.value } }))} spellCheck={false} />
              </div>
              <div className="settings-cli-subrow">
                <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text"
                  placeholder="Allowed sender IDs (comma-separated)"
                  value={ch.discord.allowedSenderIds} onChange={(e) => setCh((c) => ({ ...c, discord: { ...c.discord, allowedSenderIds: e.target.value } }))} spellCheck={false} />
                <button type="button" className="settings-btn tap-press" style={{ height: 32 }} onClick={() => void saveChannel("discord")} disabled={chBusy === "discord"}>Save</button>
              </div>
              {chMsg?.which === "discord" && <span className={`settings-form-msg ${chMsg.ok ? "ok" : "err"}`}>{chMsg.text}</span>}
            </div>
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
                            {/* Guided per-CLI setup: install status + how to authenticate. */}
                            <p className="settings-card-hint" style={{ padding: "0 16px 6px", fontSize: 11, opacity: 0.85 }}>
                              {!it.binaryOnPath && !it.hasBin && (
                                <>⚠ Not installed in the core image — rebuild with{" "}
                                <span className="settings-inline-code">INSTALL_CLIS=1</span>, or set a binary path below.{" "}</>
                              )}
                              {it.id === "claude-code" && (
                                <>Auth: run <span className="settings-inline-code">claude setup-token</span> on your computer, then paste the token below.</>
                              )}
                              {it.id === "codex-cli" && (
                                <>Auth: paste an OpenAI API key below (billed per use), or mount your{" "}
                                <span className="settings-inline-code">~/.codex</span> login for ChatGPT-subscription auth.</>
                              )}
                              {it.id === "gemini-cli" && (
                                <>Auth: paste a Google AI (Gemini) API key below.</>
                              )}
                            </p>
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
                                      : it.id === "codex-cli"
                                        ? "Paste an OpenAI API key (sk-…)"
                                        : it.id === "gemini-cli"
                                          ? "Paste a Google AI (Gemini) API key"
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

            {/* Add ANY CLI as a brain — not limited to the built-in 3. Creates a
                cli-command backend under the hood; shows up in the model picker. */}
            {cli?.uiAllowed && (
              <div style={{ marginTop: 14 }}>
                {!addCliOpen ? (
                  <button
                    type="button"
                    className="settings-btn tap-press"
                    style={{ height: 30, fontSize: 12 }}
                    onClick={() => { setAddCliOpen(true); setNewCliMsg(null); }}
                  >
                    <Plus size={13} /> Add another CLI
                  </button>
                ) : (
                  <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
                    <p className="settings-card-hint" style={{ fontSize: 11, opacity: 0.85, paddingLeft: 0 }}>
                      Add any command as a brain (e.g. Grok, Qwen, a local script). The binary
                      must be in the core image or on PATH — bundle it like Claude/Codex. Once
                      added it appears in the model picker.
                    </p>
                    <div className="settings-cli-subrow" style={{ paddingLeft: 0 }}>
                      <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Name (e.g. Grok)" value={newCli.label} onChange={(e) => setNewCli((c) => ({ ...c, label: e.target.value }))} spellCheck={false} />
                      <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Command (e.g. grok)" value={newCli.command} onChange={(e) => setNewCli((c) => ({ ...c, command: e.target.value }))} spellCheck={false} />
                    </div>
                    <div className="settings-cli-subrow" style={{ paddingLeft: 0 }}>
                      <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Args — optional, e.g. exec --model {model}" value={newCli.args} onChange={(e) => setNewCli((c) => ({ ...c, args: e.target.value }))} spellCheck={false} />
                    </div>
                    <div className="settings-cli-subrow" style={{ paddingLeft: 0 }}>
                      <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="text" placeholder="Auth env var — optional, e.g. XAI_API_KEY" value={newCli.envName} onChange={(e) => setNewCli((c) => ({ ...c, envName: e.target.value }))} spellCheck={false} />
                      <input className="settings-input" style={{ height: 32, fontSize: 12, flex: 1 }} type="password" autoComplete="off" placeholder="Auth value — optional" value={newCli.envValue} onChange={(e) => setNewCli((c) => ({ ...c, envValue: e.target.value }))} spellCheck={false} />
                    </div>
                    <div className="settings-cli-subrow" style={{ paddingLeft: 0 }}>
                      <button type="button" className="settings-btn accent tap-press" style={{ height: 32 }} onClick={() => void addCustomCli()} disabled={newCliBusy}>Add CLI</button>
                      <button type="button" className="settings-btn tap-press" style={{ height: 32 }} onClick={() => { setAddCliOpen(false); setNewCliMsg(null); }} disabled={newCliBusy}>Cancel</button>
                    </div>
                  </div>
                )}
                {newCliMsg && <span className={`settings-form-msg ${newCliMsg.ok ? "ok" : "err"}`}>{newCliMsg.text}</span>}
              </div>
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

function UpdateTargetRow({
  target,
  title,
  subtitle,
  settings,
  busy,
  onSave,
  warning,
}: {
  target: UpdateTarget;
  title: string;
  subtitle: string;
  settings?: TargetReminders;
  busy: boolean;
  onSave: (body: { mode?: UpdateReminderMode; muteForMs?: number }) => void;
  warning?: string;
}) {
  const muted = !!(settings?.mutedUntil && settings.mutedUntil > Date.now());
  return (
    <div className="settings-comp-vendor-group" style={{ marginTop: 8 }}>
      <div className="settings-provider-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {title}
        <span style={{ opacity: 0.6, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          {subtitle}
        </span>
        {muted && <SavedTag text="muted" />}
      </div>

      <div className="settings-select-list">
        {UPDATE_REMINDER_OPTIONS.map((o) => (
          <SelectRow
            key={o.value}
            active={settings?.mode === o.value}
            onClick={() => onSave({ mode: o.value })}
            label={o.label}
            hint={o.hint}
          />
        ))}
      </div>

      {warning && (
        <p className="settings-card-hint" style={{ marginTop: 8, color: "var(--color-error)", opacity: 0.9 }}>
          ⚠ {warning}
        </p>
      )}

      <div className="settings-comp-control-row">
        <div className="settings-row-text">
          <div className="settings-row-label">Mute {title.toLowerCase()} reminders</div>
          <div className="settings-row-hint">
            {muted
              ? `muted until ${new Date(settings!.mutedUntil!).toLocaleString()}`
              : "pause reminders without turning them off"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="settings-btn tap-press"
            onClick={() => onSave({ muteForMs: MUTE_DAY_MS })}
            disabled={busy}
            aria-label={`Mute ${target} reminders for one day`}
          >
            1 day
          </button>
          <button
            type="button"
            className="settings-btn tap-press"
            onClick={() => onSave({ muteForMs: MUTE_WEEK_MS })}
            disabled={busy}
            aria-label={`Mute ${target} reminders for one week`}
          >
            1 week
          </button>
          {muted && (
            <button
              type="button"
              className="settings-btn tap-press"
              onClick={() => onSave({ muteForMs: 0 })}
              disabled={busy}
              aria-label={`Unmute ${target} reminders`}
            >
              Unmute
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
