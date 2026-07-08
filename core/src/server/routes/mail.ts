import { Hono } from "hono";
import { getAccount, listAccounts } from "@/lib/accounts";
import { msListMessages, msReadMessage } from "@/lib/ms-graph/mail";
import { googleListMessages, googleReadMessage } from "@/lib/google/mail";
import type { MailListItem } from "@/lib/mail-types";

/**
 * On-demand email — read/search across ALL connected accounts (Microsoft + Google),
 * live from the provider API. Nothing is stored. `/messages` lists/searches; each
 * item carries account_id + id so `/message` can fetch one full body.
 */
export const mail = new Hono();

mail.get("/messages", async (c) => {
  const query = c.req.query("q") ?? "";
  const count = Math.min(Math.max(Number(c.req.query("count") ?? 10) || 10, 1), 25);

  const accounts = (await listAccounts()).filter((a) => a.provider === "microsoft" || a.provider === "google");
  if (accounts.length === 0) {
    return c.json({ error: "No mail account connected" }, 503);
  }

  const results = await Promise.allSettled(
    accounts.map((a) => (a.provider === "microsoft" ? msListMessages(a, query, count) : googleListMessages(a, query, count))),
  );

  const messages: MailListItem[] = [];
  const errors: Array<{ account: string; error: string }> = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") messages.push(...r.value);
    else errors.push({ account: accounts[i].account_email, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });

  if (messages.length === 0 && errors.length === accounts.length) {
    return c.json({ error: errors[0]?.error ?? "Mail fetch failed", errors }, 500);
  }

  messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return c.json({
    messages: messages.slice(0, count),
    accounts: accounts.map((a) => a.account_name || a.account_email),
    ...(errors.length ? { errors } : {}),
  });
});

mail.get("/message", async (c) => {
  const accountId = c.req.query("account_id");
  const id = c.req.query("id");
  if (!accountId || !id) return c.json({ error: "account_id and id required" }, 400);

  const acct = await getAccount(accountId);
  if (!acct) return c.json({ error: "account not found" }, 404);
  if (acct.provider !== "microsoft" && acct.provider !== "google") {
    return c.json({ error: "unsupported provider" }, 400);
  }

  try {
    const full = acct.provider === "microsoft" ? await msReadMessage(acct, id) : await googleReadMessage(acct, id);
    return c.json(full);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
