import { Hono } from "hono";
import { graphFetch } from "@/lib/ms-graph/client";

interface GraphEvent {
  id: string;
  subject: string;
  isAllDay: boolean;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  bodyPreview?: string;
  organizer?: { emailAddress: { name: string; address: string } };
}

interface GraphCalendarResponse {
  value: GraphEvent[];
}

export const calendar = new Hono();

calendar.get("/events", async (c) => {
  // Default to today
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const defaultEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const start = c.req.query("start") ?? defaultStart;
  const end = c.req.query("end") ?? defaultEnd;

  try {
    const params = new URLSearchParams({
      startDateTime: start,
      endDateTime: end,
      "$orderby": "start/dateTime",
      "$top": "50",
      "$select": "id,subject,isAllDay,start,end,location,bodyPreview,organizer",
    });

    const data = await graphFetch<GraphCalendarResponse>(`/me/calendarView?${params}`);
    return c.json({ events: data.value });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("not connected")) {
      return c.json({ error: "Microsoft 365 not connected" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});
