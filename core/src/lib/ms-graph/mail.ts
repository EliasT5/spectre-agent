import { getValidAccessTokenForAccount } from "./client";
import type { ConnectedAccount } from "@/lib/accounts";
import type { MailListItem, MailFull } from "@/lib/mail-types";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphAddress { name?: string; address?: string }
interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: GraphAddress };
  toRecipients?: Array<{ emailAddress?: GraphAddress }>;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
}
interface GraphMessages { value?: GraphMessage[] }

function fromStr(f?: { emailAddress?: GraphAddress }): string {
  const e = f?.emailAddress;
  if (!e) return "";
  if (e.name && e.address) return `${e.name} <${e.address}>`;
  return e.address || e.name || "";
}

/** Recent messages (or a $search when query given) for one Microsoft account. */
export async function msListMessages(acct: ConnectedAccount, query: string, count: number): Promise<MailListItem[]> {
  const token = await getValidAccessTokenForAccount(acct);
  const params = new URLSearchParams({ $top: String(count), $select: "id,subject,from,receivedDateTime,bodyPreview,isRead" });
  // Graph rejects $search + $orderby together, so it's one or the other.
  if (query) params.set("$search", `"${query.replace(/"/g, "")}"`);
  else params.set("$orderby", "receivedDateTime desc");

  const res = await fetch(`${GRAPH_BASE}/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Graph mail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as GraphMessages;
  const who = acct.account_name || acct.account_email;
  return (data.value ?? []).map((m): MailListItem => ({
    id: m.id,
    account_id: acct.id,
    account: who,
    provider: "microsoft",
    subject: m.subject || "(no subject)",
    from: fromStr(m.from),
    date: m.receivedDateTime || "",
    snippet: (m.bodyPreview || "").trim(),
    isRead: !!m.isRead,
  }));
}

/** Full body (plain text) of one Microsoft message. */
export async function msReadMessage(acct: ConnectedAccount, id: string): Promise<MailFull> {
  const token = await getValidAccessTokenForAccount(acct);
  const params = new URLSearchParams({ $select: "subject,from,toRecipients,receivedDateTime,body" });
  const res = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}?${params}`, {
    // Prefer plain text so the brain doesn't get raw HTML.
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Prefer: 'outlook.body-content-type="text"' },
  });
  if (!res.ok) throw new Error(`Graph mail read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const m = (await res.json()) as GraphMessage;
  const to = (m.toRecipients ?? []).map((r) => fromStr(r)).filter(Boolean).join(", ");
  return {
    subject: m.subject || "(no subject)",
    from: fromStr(m.from),
    to,
    date: m.receivedDateTime || "",
    body: (m.body?.content || "").trim(),
  };
}
