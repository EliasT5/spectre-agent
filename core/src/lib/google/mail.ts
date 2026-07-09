import { getValidAccessTokenForAccount } from "./client";
import type { ConnectedAccount } from "@/lib/accounts";
import type { MailListItem, MailFull } from "@/lib/mail-types";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader { name?: string; value?: string }
interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailPayload extends GmailPart {
  headers?: GmailHeader[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPayload;
}
interface GmailList { messages?: Array<{ id: string }> }

function b64urlDecode(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  const h = (headers ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function toISO(dateHdr: string): string {
  if (!dateHdr) return "";
  const t = Date.parse(dateHdr);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

/** Recent messages (or a search when query given) for one Google account. */
export async function googleListMessages(acct: ConnectedAccount, query: string, count: number): Promise<MailListItem[]> {
  const token = await getValidAccessTokenForAccount(acct);
  const listParams = new URLSearchParams({ maxResults: String(count) });
  if (query) listParams.set("q", query);

  const listRes = await fetch(`${GMAIL_BASE}/messages?${listParams}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!listRes.ok) throw new Error(`Gmail list ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
  const listData = (await listRes.json()) as GmailList;
  const ids = (listData.messages ?? []).map((m) => m.id);
  const who = acct.account_name || acct.account_email;

  // Gmail list returns ids only — fetch each message's metadata (subject/from/date).
  const items = await Promise.all(
    ids.map(async (id): Promise<MailListItem | null> => {
      const r = await fetch(
        `${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) return null;
      const m = (await r.json()) as GmailMessage;
      const hs = m.payload?.headers;
      return {
        id,
        account_id: acct.id,
        account: who,
        provider: "google",
        subject: header(hs, "Subject") || "(no subject)",
        from: header(hs, "From"),
        date: toISO(header(hs, "Date")),
        snippet: (m.snippet || "").trim(),
        isRead: !(m.labelIds ?? []).includes("UNREAD"),
      };
    }),
  );
  return items.filter((x): x is MailListItem => x !== null);
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  const walk = (part: GmailPart | undefined, mime: string): string => {
    if (!part) return "";
    if (part.mimeType === mime && part.body?.data) return b64urlDecode(part.body.data);
    for (const p of part.parts ?? []) {
      const r = walk(p, mime);
      if (r) return r;
    }
    return "";
  };
  return (
    walk(payload, "text/plain") ||
    walk(payload, "text/html") ||
    (payload.body?.data ? b64urlDecode(payload.body.data) : "")
  );
}

/** Full body (plain text where available) of one Google message. */
export async function googleReadMessage(acct: ConnectedAccount, id: string): Promise<MailFull> {
  const token = await getValidAccessTokenForAccount(acct);
  const r = await fetch(`${GMAIL_BASE}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail read ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const m = (await r.json()) as GmailMessage;
  const hs = m.payload?.headers;
  return {
    subject: header(hs, "Subject") || "(no subject)",
    from: header(hs, "From"),
    to: header(hs, "To"),
    date: toISO(header(hs, "Date")),
    body: extractBody(m.payload).trim(),
  };
}
