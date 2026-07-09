import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth/ct";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  getTelegramWebhookSecret,
  getTelegramAllowedIds,
  getWhatsappVerifyToken,
  getWhatsappAppSecret,
  getWhatsappAllowedIds,
} from "@/lib/channel-config";

/**
 * Messaging channels — inbound side. A channel's webhook POSTs an incoming
 * message here; we enqueue a durable Jerome turn on a per-sender thread, and the
 * channel-runner worker delivers the reply back out (see worker/channel-runner.mjs).
 *
 * Two channels: Telegram and WhatsApp (Meta Cloud API). Both webhooks are
 * reachable publicly (added to the shell's PUBLIC_PATHS so the providers, which
 * carry no session, can reach them). The security boundary on each is a
 * provider-specific secret check (fail-closed) PLUS a DEFAULT-DENY sender
 * allowlist; strangers are silently ignored.
 */
export const channels = new Hono();

// Reject oversized webhook bodies before parsing (a chat update is tiny).
const MAX_WEBHOOK_BODY = 64 * 1024;

// Per-sender sliding-window rate limit: even an allowed sender can't flood the
// durable-turn pipeline. In-memory (per core process; single-instance deploy).
// Keyed by `${channel}:${senderId}` so channels never collide.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20;
const rlHits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (rlHits.get(key) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_MAX) {
    rlHits.set(key, recent);
    return true;
  }
  recent.push(now);
  rlHits.set(key, recent);
  return false;
}

/** Comma-separated allowlist → Set. DEFAULT-DENY: empty string = nobody. The CSV
 *  now comes from the channel-config getters (Settings-set, env fallback). */
function toSet(csv: string): Set<string> {
  return new Set(
    (csv || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * One thread per (channel, sender) so context persists. The thread's
 * metadata.channel routes the outbound reply. Returns the thread id (or null).
 */
async function ensureChannelThread(
  supabase: ReturnType<typeof createServiceSupabase>,
  channel: string,
  senderId: string,
  title: string,
  channelMeta: Record<string, unknown>,
): Promise<string | null> {
  const { data: acct } = await supabase
    .from("channel_accounts")
    .select("thread_id")
    .eq("channel", channel)
    .eq("sender_id", senderId)
    .maybeSingle();
  let threadId = (acct as { thread_id: string | null } | null)?.thread_id ?? null;

  if (!threadId) {
    const { data: t } = await supabase
      .from("threads")
      .insert({ title, metadata: { channel: channelMeta } })
      .select("id")
      .single();
    threadId = (t as { id: string } | null)?.id ?? null;
    if (threadId) {
      await supabase
        .from("channel_accounts")
        .upsert(
          { channel, sender_id: senderId, thread_id: threadId, allowed: true },
          { onConflict: "channel,sender_id" },
        );
    }
  }
  return threadId;
}

/**
 * Durable turn: the raw user text + a queued assistant placeholder. The
 * chat-runner claims the placeholder and runs the full brain on the thread; the
 * channel-runner then delivers the finished reply back over the channel.
 */
async function enqueueTurn(
  supabase: ReturnType<typeof createServiceSupabase>,
  threadId: string,
  text: string,
): Promise<void> {
  await supabase.from("messages").insert({ thread_id: threadId, role: "user", content: text, status: "done" });
  await supabase.from("messages").insert({ thread_id: threadId, role: "assistant", content: "", status: "queued" });
}

// ── Telegram ────────────────────────────────────────────────────────────────
// Secret = the per-bot token Telegram echoes in X-Telegram-Bot-Api-Secret-Token
// (set when you call setWebhook).
channels.post("/telegram/webhook", async (c) => {
  const secret = getTelegramWebhookSecret();
  if (!secret) return c.json({ ok: false }, 503); // fail closed
  if (!safeEqual(c.req.header("x-telegram-bot-api-secret-token"), secret)) {
    return c.json({ ok: false }, 401);
  }

  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_WEBHOOK_BODY) return c.json({ ok: false }, 413);

  const update = (await c.req.json().catch(() => ({}))) as {
    message?: TgMessage;
    edited_message?: TgMessage;
  };
  const msg = update.message ?? update.edited_message;
  const fromId = msg?.from?.id != null ? String(msg.from.id) : null;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : null;
  const text = typeof msg?.text === "string" ? msg.text.trim() : "";

  // Always 200 so Telegram doesn't retry; we just don't act on non-text/junk.
  if (!fromId || !chatId || !text) return c.json({ ok: true });
  if (!toSet(getTelegramAllowedIds()).has(fromId)) return c.json({ ok: true });
  if (rateLimited(`telegram:${fromId}`)) return c.json({ ok: true });

  const supabase = createServiceSupabase();
  const threadId = await ensureChannelThread(supabase, "telegram", fromId, `Telegram · ${fromId}`, {
    type: "telegram",
    chat_id: chatId,
  });
  if (threadId) await enqueueTurn(supabase, threadId, text);

  return c.json({ ok: true });
});

// ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────────────
// GET = webhook verification handshake (Meta sends hub.challenge once on setup).
channels.get("/whatsapp/webhook", (c) => {
  const verify = getWhatsappVerifyToken();
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge") ?? "";
  if (verify && mode === "subscribe" && safeEqual(token, verify)) {
    return c.text(challenge, 200);
  }
  return c.json({ ok: false }, 403);
});

// POST = inbound messages. Boundary = the X-Hub-Signature-256 HMAC (App Secret)
// over the RAW body, plus a default-deny sender (wa_id) allowlist.
channels.post("/whatsapp/webhook", async (c) => {
  const appSecret = getWhatsappAppSecret();
  if (!appSecret) return c.json({ ok: false }, 503); // fail closed

  const raw = await c.req.text();
  if (raw.length > MAX_WEBHOOK_BODY) return c.json({ ok: false }, 413);

  const expected = "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex");
  if (!safeEqual(c.req.header("x-hub-signature-256"), expected)) {
    return c.json({ ok: false }, 401);
  }

  let body: WaWebhook;
  try {
    body = JSON.parse(raw) as WaWebhook;
  } catch {
    return c.json({ ok: true });
  }

  const supabase = createServiceSupabase();
  const allowed = toSet(getWhatsappAllowedIds());

  // Meta batches updates: entry[] → changes[] → value.messages[].
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? null;
      for (const msg of value?.messages ?? []) {
        if (msg.type !== "text") continue; // text-only for now
        const from = msg.from ? String(msg.from) : null;
        const text = msg.text?.body?.trim() || "";
        if (!from || !text) continue;
        if (!allowed.has(from)) continue; // default-deny
        if (rateLimited(`whatsapp:${from}`)) continue;

        const threadId = await ensureChannelThread(supabase, "whatsapp", from, `WhatsApp · ${from}`, {
          type: "whatsapp",
          wa_id: from,
          phone_number_id: phoneNumberId,
        });
        if (threadId) await enqueueTurn(supabase, threadId, text);
      }
    }
  }

  // Always 200 so Meta doesn't retry or disable the subscription.
  return c.json({ ok: true });
});

interface TgMessage {
  from?: { id?: number | string };
  chat?: { id?: number | string };
  text?: string;
}

interface WaWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          from?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}
