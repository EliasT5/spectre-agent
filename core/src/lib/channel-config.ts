import { createServiceSupabase } from "@/lib/supabase/server";

/**
 * Messaging-channel secrets (Telegram / WhatsApp / Discord) — set from Settings
 * (no .env edit), stored in app_config, read at use-time. Falls back to the
 * per-channel env vars. Tokens/secrets are never echoed to the UI (only `hasX`);
 * the non-secret bits (allowlists, phone number id, graph version) are returned so
 * the Settings form can prefill them. Mirrors github-token.ts / vapid.ts.
 *
 * The core (inbound webhooks in routes/channels.ts) reads these getters directly.
 * The channel-runner WORKER can't import this TS module, so it reads the same
 * app_config `channels` row itself and refreshes at runtime — keep the stored
 * shape below in sync with worker/channel-runner.mjs refreshChannelConfig().
 */
export interface ChannelConfig {
  telegram: { botToken?: string; webhookSecret?: string; allowedSenderIds?: string };
  whatsapp: {
    token?: string;
    phoneNumberId?: string;
    verifyToken?: string;
    appSecret?: string;
    allowedSenderIds?: string;
    graphVersion?: string;
  };
  discord: { botToken?: string; allowedSenderIds?: string };
}

const KEY = "channels";
let stored: Partial<ChannelConfig> = {};

// Blank in the stored config → fall back to the env var.
function pick(v: string | undefined, env: string | undefined): string {
  if (v && v.trim()) return v.trim();
  return env && env.trim() ? env.trim() : "";
}

// ── Telegram ──────────────────────────────────────────────────────────────────
export function getTelegramBotToken(): string { return pick(stored.telegram?.botToken, process.env.TELEGRAM_BOT_TOKEN); }
export function getTelegramWebhookSecret(): string { return pick(stored.telegram?.webhookSecret, process.env.TELEGRAM_WEBHOOK_SECRET); }
export function getTelegramAllowedIds(): string { return pick(stored.telegram?.allowedSenderIds, process.env.TELEGRAM_ALLOWED_SENDER_IDS); }

// ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────────────
export function getWhatsappToken(): string { return pick(stored.whatsapp?.token, process.env.WHATSAPP_TOKEN); }
export function getWhatsappPhoneNumberId(): string { return pick(stored.whatsapp?.phoneNumberId, process.env.WHATSAPP_PHONE_NUMBER_ID); }
export function getWhatsappVerifyToken(): string { return pick(stored.whatsapp?.verifyToken, process.env.WHATSAPP_VERIFY_TOKEN); }
export function getWhatsappAppSecret(): string { return pick(stored.whatsapp?.appSecret, process.env.WHATSAPP_APP_SECRET); }
export function getWhatsappAllowedIds(): string { return pick(stored.whatsapp?.allowedSenderIds, process.env.WHATSAPP_ALLOWED_SENDER_IDS); }
export function getWhatsappGraphVersion(): string { return pick(stored.whatsapp?.graphVersion, process.env.WHATSAPP_GRAPH_VERSION) || "v21.0"; }

// ── Discord ───────────────────────────────────────────────────────────────────
export function getDiscordBotToken(): string { return pick(stored.discord?.botToken, process.env.DISCORD_BOT_TOKEN); }
export function getDiscordAllowedIds(): string { return pick(stored.discord?.allowedSenderIds, process.env.DISCORD_ALLOWED_SENDER_IDS); }

/** Non-secret status for the UI — never returns a token/secret, only `hasX`. */
export function channelsStatus() {
  return {
    telegram: {
      hasBotToken: !!getTelegramBotToken(),
      hasWebhookSecret: !!getTelegramWebhookSecret(),
      allowedSenderIds: getTelegramAllowedIds(),
    },
    whatsapp: {
      hasToken: !!getWhatsappToken(),
      phoneNumberId: getWhatsappPhoneNumberId(),
      hasVerifyToken: !!getWhatsappVerifyToken(),
      hasAppSecret: !!getWhatsappAppSecret(),
      allowedSenderIds: getWhatsappAllowedIds(),
      graphVersion: getWhatsappGraphVersion(),
    },
    discord: {
      hasBotToken: !!getDiscordBotToken(),
      allowedSenderIds: getDiscordAllowedIds(),
    },
  };
}

// Secret fields: a blank value KEEPS the stored secret (so a partial save can't
// wipe a token). Non-secret fields: a blank value CLEARS them.
const SECRET_FIELDS = new Set(["botToken", "webhookSecret", "token", "verifyToken", "appSecret"]);

export async function setChannels(patch: Partial<ChannelConfig>): Promise<void> {
  const next: Record<string, Record<string, string>> = {
    telegram: { ...(stored.telegram as Record<string, string> | undefined) },
    whatsapp: { ...(stored.whatsapp as Record<string, string> | undefined) },
    discord: { ...(stored.discord as Record<string, string> | undefined) },
  };
  for (const ch of ["telegram", "whatsapp", "discord"] as const) {
    const p = patch[ch] as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") continue;
    for (const [k, raw] of Object.entries(p)) {
      if (typeof raw !== "string") continue;
      const t = raw.trim();
      if (t) next[ch][k] = t;
      else if (!SECRET_FIELDS.has(k)) delete next[ch][k];
      // blank + secret → keep the stored value
    }
  }
  stored = next as Partial<ChannelConfig>;
  try {
    const supabase = createServiceSupabase();
    await supabase.from("app_config").upsert(
      { key: KEY, value: JSON.stringify(stored), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  } catch {
    /* fail-soft */
  }
}

export async function hydrateChannels(): Promise<void> {
  try {
    const supabase = createServiceSupabase();
    const { data } = await supabase.from("app_config").select("value").eq("key", KEY).maybeSingle();
    if (data?.value) {
      const v = JSON.parse(data.value as string);
      if (v && typeof v === "object") stored = v as Partial<ChannelConfig>;
    }
  } catch {
    /* fail-soft */
  }
}

void hydrateChannels();
