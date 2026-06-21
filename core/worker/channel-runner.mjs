// Channel outbound runner. The inbound webhook (src/server/routes/channels.ts)
// enqueues a durable turn on a channel-bound thread (threads.metadata.channel);
// the chat-runner runs the brain and writes the assistant reply to status:'done'.
// THIS worker watches those finished replies and delivers them back out over the
// channel (Telegram sendMessage), stamping messages.delivered_at so each reply is
// sent exactly once (durable across restarts).
//
//   bun worker/channel-runner.mjs   (prod: the compiled spectre-channel-runner)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
//      WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID (fallback), WHATSAPP_GRAPH_VERSION,
//      DISCORD_BOT_TOKEN, DISCORD_ALLOWED_SENDER_IDS.
//
// Inbound: Telegram + WhatsApp arrive as HTTP webhooks at the core
// (src/server/routes/channels.ts). Discord has no webhook for free-text messages,
// so THIS worker also holds the Discord Gateway WebSocket (discord-gateway.mjs)
// and enqueues durable turns for inbound Discord messages directly.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startDiscordGateway } from "./discord-gateway.mjs";

try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* rely on real env */
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WA_GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || "v21.0"}`;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_API = "https://discord.com/api/v10";
const CORE_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:8787";
const POLL_MS = Number(process.env.CHANNEL_RUNNER_POLL_MS || 1500);

// Default-deny allowlist (env, comma-separated). Empty = nobody.
function allowlist(name) {
  return new Set((process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean));
}

// Generated-image URL (a screenshot or openai.image output) embedded in a reply.
const GENERATED_IMG_RE = /\/generated\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif)/gi;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[channel-runner] missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Telegram caps a message at 4096 chars; split conservatively.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
      timeout: false,
    });
    if (!res.ok) {
      console.error(`[channel-runner] telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[channel-runner] telegram send failed: ${e.message}`);
    return false;
  }
}

async function sendTelegramPhoto(chatId, bytes, caption) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 1024));
    form.append("photo", new Blob([bytes], { type: "image/png" }), "screenshot.png");
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form,
      timeout: false,
    });
    if (!res.ok) console.error(`[channel-runner] sendPhoto ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.error(`[channel-runner] sendPhoto failed: ${e.message}`);
    return false;
  }
}

// Fetch a generated image's bytes from the core's (un-gated, loopback) byte route.
async function fetchGeneratedImage(urlPath) {
  try {
    const res = await fetch(`${CORE_URL}${urlPath}`, { timeout: false });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Deliver a reply to Telegram: if it embeds generated image(s) (screenshots),
// send them as photos (the user SEES them) with the prose as the caption;
// otherwise a plain text message.
async function deliverTelegram(chatId, content) {
  const images = [...content.matchAll(GENERATED_IMG_RE)].map((m) => m[0]);
  if (images.length === 0) return sendTelegram(chatId, content);

  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\/generated\/[^)]*\)/g, "") // ![alt](…/generated/…)
    .replace(GENERATED_IMG_RE, "")
    .trim();

  let ok = true;
  let first = true;
  for (const img of images) {
    const bytes = await fetchGeneratedImage(img);
    if (!bytes) {
      ok = false;
      continue;
    }
    ok = (await sendTelegramPhoto(chatId, bytes, first ? text : "")) && ok;
    first = false;
  }
  // No photo carried the text (every image fetch failed) — still send the prose.
  if (first && text) ok = (await sendTelegram(chatId, text)) && ok;
  return ok;
}

// ── WhatsApp (Meta Cloud API) ─────────────────────────────────────────────────
// `to` = the sender's wa_id; `phoneNumberId` = OUR number (from the inbound
// metadata, stored on the thread). Free-form replies are valid because the user
// just messaged us (inside WhatsApp's 24-hour customer-service window).
async function sendWhatsapp(phoneNumberId, to, text) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) return false;
  try {
    const res = await fetch(`${WA_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: text.slice(0, 4096) },
      }),
      timeout: false,
    });
    if (!res.ok) console.error(`[channel-runner] whatsapp send ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.error(`[channel-runner] whatsapp send failed: ${e.message}`);
    return false;
  }
}

// Upload image bytes to WhatsApp media, then send by media id (our /generated
// images live on the core's loopback, so there's no public URL to link).
async function sendWhatsappImage(phoneNumberId, to, bytes, caption) {
  if (!WHATSAPP_TOKEN || !phoneNumberId) return false;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/png");
    form.append("file", new Blob([bytes], { type: "image/png" }), "image.png");
    const up = await fetch(`${WA_GRAPH}/${phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
      timeout: false,
    });
    if (!up.ok) {
      console.error(`[channel-runner] whatsapp media ${up.status}: ${(await up.text()).slice(0, 200)}`);
      return false;
    }
    const mediaId = (await up.json())?.id;
    if (!mediaId) return false;
    const res = await fetch(`${WA_GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: caption ? { id: mediaId, caption: caption.slice(0, 1024) } : { id: mediaId },
      }),
      timeout: false,
    });
    if (!res.ok) console.error(`[channel-runner] whatsapp sendImage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.error(`[channel-runner] whatsapp sendImage failed: ${e.message}`);
    return false;
  }
}

// Deliver a reply to WhatsApp: generated images become image messages (prose as
// the caption on the first), otherwise a plain text message. Mirrors Telegram.
async function deliverWhatsapp(ch, content) {
  const phoneNumberId = ch.phone_number_id || WHATSAPP_PHONE_NUMBER_ID;
  const to = ch.wa_id;
  if (!phoneNumberId || !to) return false;

  const images = [...content.matchAll(GENERATED_IMG_RE)].map((m) => m[0]);
  if (images.length === 0) return sendWhatsapp(phoneNumberId, to, content);

  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\/generated\/[^)]*\)/g, "")
    .replace(GENERATED_IMG_RE, "")
    .trim();

  let ok = true;
  let first = true;
  for (const img of images) {
    const bytes = await fetchGeneratedImage(img);
    if (!bytes) {
      ok = false;
      continue;
    }
    ok = (await sendWhatsappImage(phoneNumberId, to, bytes, first ? text : "")) && ok;
    first = false;
  }
  if (first && text) ok = (await sendWhatsapp(phoneNumberId, to, text)) && ok;
  return ok;
}

// ── Discord (REST outbound) ───────────────────────────────────────────────────
// Reply to the channel the message came from. Bot-token auth. Content cap 2000.
async function sendDiscord(channelId, text) {
  if (!DISCORD_BOT_TOKEN || !channelId) return false;
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
      timeout: false,
    });
    if (!res.ok) console.error(`[channel-runner] discord send ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.error(`[channel-runner] discord send failed: ${e.message}`);
    return false;
  }
}

// Upload an image as a Discord attachment (multipart), with optional caption.
async function sendDiscordImage(channelId, bytes, caption) {
  if (!DISCORD_BOT_TOKEN || !channelId) return false;
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: (caption || "").slice(0, 2000) }));
    form.append("files[0]", new Blob([bytes], { type: "image/png" }), "image.png");
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      body: form,
      timeout: false,
    });
    if (!res.ok) console.error(`[channel-runner] discord sendImage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (e) {
    console.error(`[channel-runner] discord sendImage failed: ${e.message}`);
    return false;
  }
}

// Mirror deliverTelegram/deliverWhatsapp: images as attachments (prose caption on
// the first), else a plain message.
async function deliverDiscord(ch, content) {
  const channelId = ch.channel_id;
  if (!channelId) return false;

  const images = [...content.matchAll(GENERATED_IMG_RE)].map((m) => m[0]);
  if (images.length === 0) return sendDiscord(channelId, content);

  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\/generated\/[^)]*\)/g, "")
    .replace(GENERATED_IMG_RE, "")
    .trim();

  let ok = true;
  let first = true;
  for (const img of images) {
    const bytes = await fetchGeneratedImage(img);
    if (!bytes) {
      ok = false;
      continue;
    }
    ok = (await sendDiscordImage(channelId, bytes, first ? text : "")) && ok;
    first = false;
  }
  if (first && text) ok = (await sendDiscord(channelId, text)) && ok;
  return ok;
}

async function deliver(messageId) {
  await supabase.from("messages").update({ delivered_at: new Date().toISOString() }).eq("id", messageId);
}

async function tick() {
  // Channel-bound threads (small set) -> a map of threadId -> channel descriptor.
  const { data: threads, error: tErr } = await supabase
    .from("threads")
    .select("id, metadata")
    .not("metadata->channel", "is", null);
  if (tErr) {
    console.error(`[channel-runner] thread poll error: ${tErr.message}`);
    return;
  }
  if (!threads?.length) return;
  const channelOf = new Map(threads.map((t) => [t.id, t.metadata?.channel]));

  const { data: msgs, error: mErr } = await supabase
    .from("messages")
    .select("id, thread_id, content")
    .eq("role", "assistant")
    .eq("status", "done")
    .is("delivered_at", null)
    .in("thread_id", [...channelOf.keys()])
    .order("created_at", { ascending: true })
    .limit(20);
  if (mErr) {
    console.error(`[channel-runner] message poll error: ${mErr.message}`);
    return;
  }

  for (const m of msgs ?? []) {
    const ch = channelOf.get(m.thread_id);
    const content = (m.content ?? "").trim();
    if (ch?.type === "telegram" && content) {
      const ok = await deliverTelegram(ch.chat_id, content);
      if (ok) await deliver(m.id);
      // If send fails, leave delivered_at null -> retried next tick.
    } else if (ch?.type === "whatsapp" && content) {
      const ok = await deliverWhatsapp(ch, content);
      if (ok) await deliver(m.id);
    } else if (ch?.type === "discord" && content) {
      const ok = await deliverDiscord(ch, content);
      if (ok) await deliver(m.id);
    } else {
      // Unknown channel type or empty body: mark delivered so we don't re-scan it.
      await deliver(m.id);
    }
  }
}

// ── Discord inbound (Gateway) ─────────────────────────────────────────────────
// The webhook channels (Telegram/WhatsApp) create the durable turn in the core;
// Discord arrives over our Gateway socket, so we enqueue it here. These mirror
// the core's ensureChannelThread + enqueueTurn (src/server/routes/channels.ts).
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20;
const rlHits = new Map();
function rateLimited(key) {
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

async function ensureChannelThread(channel, senderId, title, channelMeta) {
  const { data: acct } = await supabase
    .from("channel_accounts")
    .select("thread_id")
    .eq("channel", channel)
    .eq("sender_id", senderId)
    .maybeSingle();
  let threadId = acct?.thread_id ?? null;
  if (!threadId) {
    const { data: t } = await supabase
      .from("threads")
      .insert({ title, metadata: { channel: channelMeta } })
      .select("id")
      .single();
    threadId = t?.id ?? null;
    if (threadId) {
      await supabase
        .from("channel_accounts")
        .upsert({ channel, sender_id: senderId, thread_id: threadId, allowed: true }, { onConflict: "channel,sender_id" });
    }
  }
  return threadId;
}

async function enqueueTurn(threadId, text) {
  await supabase.from("messages").insert({ thread_id: threadId, role: "user", content: text, status: "done" });
  await supabase.from("messages").insert({ thread_id: threadId, role: "assistant", content: "", status: "queued" });
}

if (DISCORD_BOT_TOKEN) {
  const allowedDiscord = allowlist("DISCORD_ALLOWED_SENDER_IDS");
  startDiscordGateway({
    token: DISCORD_BOT_TOKEN,
    log: (s) => console.log(`[channel-runner] ${s}`),
    onMessage: async ({ channelId, authorId, content }) => {
      try {
        if (!allowedDiscord.has(authorId)) return; // default-deny
        if (rateLimited(`discord:${authorId}`)) return;
        const threadId = await ensureChannelThread("discord", authorId, `Discord · ${authorId}`, {
          type: "discord",
          channel_id: channelId,
        });
        if (threadId) await enqueueTurn(threadId, content);
      } catch (e) {
        console.error(`[channel-runner] discord inbound: ${e.message}`);
      }
    },
  });
}

console.log(
  `[channel-runner] up — polling every ${POLL_MS}ms ` +
    `(telegram=${TELEGRAM_BOT_TOKEN ? "on" : "off"}, whatsapp=${WHATSAPP_TOKEN ? "on" : "off"}, ` +
    `discord=${DISCORD_BOT_TOKEN ? "on" : "off"})`,
);
setInterval(() => {
  tick().catch((e) => console.error(`[channel-runner] tick: ${e.message}`));
}, POLL_MS);
