import { Hono } from "hono";
import { graphFetchForAccount, listMsAccounts } from "@/lib/ms-graph/client";
import { googleCalendarEvents, listGoogleAccounts } from "@/lib/google/client";

interface CalEvent {
  id: string;
  subject: string;
  isAllDay: boolean;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName: string };
  bodyPreview?: string;
  organizer?: { emailAddress: { name: string; address: string } };
  account: string;
}

interface GraphCalendarResponse {
  value: Omit<CalEvent, "account">[];
}

export const calendar = new Hono();

// Merged calendar across ALL connected accounts (Microsoft + Google). Each event
// is tagged with `account` (source), so tools can show which calendar it's from.
calendar.get("/events", async (c) => {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const defaultEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const start = c.req.query("start") ?? defaultStart;
  const end = c.req.query("end") ?? defaultEnd;

  const [msAccounts, googleAccounts] = await Promise.all([listMsAccounts(), listGoogleAccounts()]);
  const total = msAccounts.length + googleAccounts.length;
  if (total === 0) {
    return c.json({ error: "No calendar account connected" }, 503);
  }

  const msParams = new URLSearchParams({
    startDateTime: start,
    endDateTime: end,
    "$orderby": "start/dateTime",
    "$top": "50",
    "$select": "id,subject,isAllDay,start,end,location,bodyPreview,organizer",
  });

  // One task per account, across both providers.
  const tasks: Array<{ email: string; run: () => Promise<CalEvent[]> }> = [
    ...msAccounts.map((acct) => ({
      email: acct.account_email,
      run: async (): Promise<CalEvent[]> => {
        const data = await graphFetchForAccount<GraphCalendarResponse>(acct, `/me/calendarView?${msParams}`);
        const who = acct.account_name || acct.account_email;
        return data.value.map((e) => ({ ...e, account: who }));
      },
    })),
    ...googleAccounts.map((acct) => ({
      email: acct.account_email,
      run: (): Promise<CalEvent[]> => googleCalendarEvents(acct, start, end),
    })),
  ];

  const results = await Promise.allSettled(tasks.map((t) => t.run()));

  const events: CalEvent[] = [];
  const errors: Array<{ account: string; error: string }> = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") events.push(...r.value);
    else errors.push({ account: tasks[i].email, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });

  // Every account failed → surface the error rather than an empty calendar.
  if (events.length === 0 && errors.length === total) {
    return c.json({ error: errors[0]?.error ?? "Calendar fetch failed", errors }, 500);
  }

  events.sort((a, b) => new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime());

  return c.json({
    events,
    accounts: [...msAccounts, ...googleAccounts].map((a) => a.account_name || a.account_email),
    ...(errors.length ? { errors } : {}),
  });
});
