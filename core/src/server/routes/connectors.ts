import { Hono } from "hono";
import { createServiceSupabase } from "@/lib/supabase/server";
import { hasGithubToken } from "@/lib/github-token";
import { listAccounts, type Provider } from "@/lib/accounts";
import { hasMsGraphCreds } from "@/lib/ms-graph/creds";
import { hasGoogleCreds } from "@/lib/google/creds";
import { getTelegramBotToken, getWhatsappToken, getDiscordBotToken } from "@/lib/channel-config";
import { hasVapid } from "@/lib/vapid";

/**
 * GET /api/connectors — a secret-free health snapshot of every integration, so
 * Spectre (and the Monitor tab) can see WHAT is connected without ever reading a
 * token. Returns only booleans/identity ({name, status, detail}) — never a
 * credential value. Cheap config checks + a few LOCAL probes (workspace sidecar,
 * LiteLLM gateway, DB); no external API calls, so it is safe to poll.
 */
export const connectors = new Hono();

type Status = "connected" | "configured" | "needs-setup" | "off" | "error";
interface Connector { name: string; status: Status; detail?: string }

const has = (v?: string | null): boolean => typeof v === "string" && v.trim().length > 0;

async function probeOk(url: string, init: RequestInit = {}): Promise<boolean> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function countAccounts(provider: Provider): Promise<number> {
  try {
    return (await listAccounts(provider)).length;
  } catch {
    return 0;
  }
}

connectors.get("/", async (c) => {
  const checks: Array<Promise<Connector>> = [
    (async (): Promise<Connector> => ({
      name: "GitHub",
      status: hasGithubToken() ? "connected" : "off",
      detail: hasGithubToken() ? "token stored" : "not signed in",
    }))(),

    (async (): Promise<Connector> => {
      const n = await countAccounts("microsoft");
      if (n > 0) {
        return { name: "Microsoft 365", status: "connected", detail: `${n} account${n === 1 ? "" : "s"} linked` };
      }
      const canConnect = hasMsGraphCreds();
      return {
        name: "Microsoft 365",
        status: canConnect ? "needs-setup" : "off",
        detail: canConnect ? "not connected — click Connect" : "no app credentials",
      };
    })(),

    (async (): Promise<Connector> => {
      const n = await countAccounts("google");
      if (n > 0) {
        return { name: "Google", status: "connected", detail: `${n} account${n === 1 ? "" : "s"} linked` };
      }
      const canConnect = hasGoogleCreds();
      return {
        name: "Google",
        status: canConnect ? "needs-setup" : "off",
        detail: canConnect ? "not connected — click Connect" : "no app credentials",
      };
    })(),

    (async (): Promise<Connector> => {
      const on = has(getTelegramBotToken());
      return { name: "Telegram", status: on ? "configured" : "off", detail: on ? "bot token set" : "no bot token" };
    })(),

    (async (): Promise<Connector> => {
      const on = has(getWhatsappToken());
      return { name: "WhatsApp", status: on ? "configured" : "off", detail: on ? "access token set" : "no token" };
    })(),

    (async (): Promise<Connector> => {
      const on = has(getDiscordBotToken());
      return { name: "Discord", status: on ? "configured" : "off", detail: on ? "bot token set" : "no bot token" };
    })(),

    (async (): Promise<Connector> => {
      if (!hasVapid()) return { name: "Web push", status: "off", detail: "no VAPID keys" };
      let subs = 0;
      try {
        const supabase = createServiceSupabase();
        const { count } = await supabase.from("push_subscriptions").select("id", { count: "exact", head: true });
        subs = count ?? 0;
      } catch { /* ignore */ }
      return {
        name: "Web push",
        status: subs > 0 ? "connected" : "configured",
        detail: subs > 0 ? `${subs} device${subs === 1 ? "" : "s"}` : "keys set, no devices",
      };
    })(),

    (async (): Promise<Connector> => {
      const base = process.env.WORKSPACE_URL || "http://workspace:8010";
      const up = await probeOk(`${base.replace(/\/$/, "")}/health`);
      return {
        name: "Workspace (VS Code)",
        status: up ? "connected" : "off",
        detail: up ? "sidecar up" : "not running (enable the workspace profile)",
      };
    })(),

    (async (): Promise<Connector> => {
      const base = process.env.SPECTRE_LITELLM_URL;
      if (!has(base)) return { name: "Model gateway", status: "off", detail: "no LiteLLM URL" };
      const up = await probeOk(`${base!.replace(/\/$/, "")}/models`, {
        headers: has(process.env.SPECTRE_LITELLM_KEY) ? { Authorization: `Bearer ${process.env.SPECTRE_LITELLM_KEY}` } : {},
      });
      return { name: "Model gateway", status: up ? "connected" : "error", detail: up ? "LiteLLM reachable" : "gateway unreachable" };
    })(),

    (async (): Promise<Connector> => {
      try {
        const supabase = createServiceSupabase();
        const { error } = await supabase.from("messages").select("status").limit(1);
        return { name: "Database", status: error ? "error" : "connected", detail: error ? "unreachable / schema" : "Supabase ready" };
      } catch {
        return { name: "Database", status: "error", detail: "unreachable" };
      }
    })(),
  ];

  const settled = await Promise.allSettled(checks);
  const list = settled.map((s): Connector => (s.status === "fulfilled" ? s.value : { name: "unknown", status: "error" }));
  return c.json({ connectors: list });
});
