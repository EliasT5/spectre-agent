// Discord inbound — a minimal, dependency-free Gateway (v10) client.
//
// Unlike Telegram/WhatsApp (HTTP webhooks), a conversational Discord bot receives
// messages over a persistent WebSocket. We use the global WebSocket (bun/Node 21+)
// so the core stays dep-free — no discord.js. This handles the HELLO/heartbeat/
// IDENTIFY handshake, RESUME on reconnect, and surfaces MESSAGE_CREATE events
// (DMs, or @-mentions in a guild) via onMessage. Outbound replies go over REST
// from the channel-runner (deliverDiscord). Start with startDiscordGateway(...).

const GATEWAY_QS = "?v=10&encoding=json";
const DEFAULT_GATEWAY = "wss://gateway.discord.gg/" + GATEWAY_QS;

// Intents: GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15).
// MESSAGE_CONTENT is privileged — enable it in the Dev Portal (Bot → Privileged
// Gateway Intents). Without it, message text arrives empty.
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

/**
 * @param {object} cfg
 * @param {string} cfg.token        Discord bot token.
 * @param {(m:{channelId:string,authorId:string,content:string,guildId?:string})=>void} cfg.onMessage
 * @param {(s:string)=>void} [cfg.log]
 */
export function startDiscordGateway({ token, onMessage, log = () => {} }) {
  let ws = null;
  let seq = null;
  let hbTimer = null;
  let acked = true;
  let sessionId = null;
  let resumeUrl = null;
  let botUserId = null;
  let backoff = 1000;
  let closed = false;

  const send = (op, d) => {
    try {
      ws?.send(JSON.stringify({ op, d }));
    } catch {
      /* socket gone — onclose will reconnect */
    }
  };

  const heartbeat = () => {
    if (!acked) {
      // missed an ACK → the connection is zombied; drop it and reconnect/resume.
      try { ws?.close(4000); } catch { /* already closing */ }
      return;
    }
    acked = false;
    send(1, seq);
  };

  const identify = () => {
    send(2, {
      token,
      intents: INTENTS,
      properties: { os: "linux", browser: "spectre", device: "spectre" },
    });
  };

  const resume = () => send(6, { token, session_id: sessionId, seq });

  const stripMention = (content) =>
    content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();

  const handleDispatch = (t, d) => {
    if (t === "READY") {
      sessionId = d?.session_id ?? null;
      resumeUrl = d?.resume_gateway_url ? d.resume_gateway_url + GATEWAY_QS : null;
      botUserId = d?.user?.id ?? null;
      backoff = 1000; // healthy connection — reset backoff
      log(`discord: ready as ${d?.user?.username ?? "bot"} (${botUserId})`);
      return;
    }
    if (t === "RESUMED") {
      backoff = 1000;
      return;
    }
    if (t !== "MESSAGE_CREATE" || !d) return;

    if (d.author?.bot || !d.author?.id) return; // ignore bots + our own messages
    if (d.author.id === botUserId) return;

    const inGuild = !!d.guild_id;
    if (inGuild) {
      // In a server, only act when the bot is @-mentioned (avoid replying to all).
      const mentioned = (d.mentions || []).some((u) => u.id === botUserId);
      if (!mentioned) return;
    }
    const content = stripMention(d.content || "");
    if (!content) return;

    onMessage({
      channelId: d.channel_id,
      authorId: d.author.id,
      content,
      guildId: d.guild_id,
    });
  };

  const connect = () => {
    if (closed) return;
    const url = sessionId && resumeUrl ? resumeUrl : DEFAULT_GATEWAY;
    log(`discord: connecting (${sessionId ? "resume" : "fresh"})`);
    ws = new WebSocket(url);

    ws.addEventListener("message", (ev) => {
      let p;
      try {
        p = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (p.s != null) seq = p.s;

      switch (p.op) {
        case 10: // HELLO → heartbeat + (resume | identify)
          clearInterval(hbTimer);
          acked = true;
          hbTimer = setInterval(heartbeat, p.d.heartbeat_interval);
          if (sessionId) resume();
          else identify();
          break;
        case 11: // HEARTBEAT ACK
          acked = true;
          break;
        case 1: // server asked us to heartbeat now
          send(1, seq);
          break;
        case 7: // reconnect requested → close, will resume
          try { ws.close(4900); } catch { /* noop */ }
          break;
        case 9: // invalid session → start fresh
          sessionId = null;
          resumeUrl = null;
          try { ws.close(4900); } catch { /* noop */ }
          break;
        case 0: // DISPATCH
          handleDispatch(p.t, p.d);
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      clearInterval(hbTimer);
      if (closed) return;
      backoff = Math.min(backoff * 2, 60_000);
      log(`discord: disconnected — reconnecting in ${Math.round(backoff / 1000)}s`);
      setTimeout(connect, backoff);
    });

    ws.addEventListener("error", () => {
      // surfaced as a close right after; nothing to do here.
    });
  };

  connect();
  return {
    stop() {
      closed = true;
      clearInterval(hbTimer);
      try { ws?.close(1000); } catch { /* noop */ }
    },
  };
}
