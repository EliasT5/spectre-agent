import {
  listAccounts,
  updateAccountTokens,
  type ConnectedAccount,
} from "@/lib/accounts";
import { getGoogleClientId, getGoogleClientSecret } from "./creds";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// openid+email → identify the account; profile → display name; calendar.readonly
// → read events; gmail.readonly → read mail. offline access (access_type=offline)
// gets us the refresh token.
export const GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly";

// Normalized event shape — matches the Microsoft Graph shape the calendar route
// and MCP broker already consume (subject / isAllDay / start.dateTime / etc).
export interface NormalizedEvent {
  id: string;
  subject: string;
  isAllDay: boolean;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: { displayName: string };
  account: string;
}

interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

async function doRefresh(refreshToken: string): Promise<RefreshedTokens> {
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return {
    access_token: json.access_token as string,
    // Google does not return a new refresh token on refresh — keep the stored one.
    refresh_token: (json.refresh_token as string | undefined) ?? refreshToken,
    expires_at: new Date(Date.now() + (json.expires_in as number) * 1000).toISOString(),
  };
}

/** All connected Google accounts. */
export function listGoogleAccounts(): Promise<ConnectedAccount[]> {
  return listAccounts("google");
}

/** A valid access token for ONE account, refreshing (and persisting) near expiry. */
export async function getValidAccessTokenForAccount(acct: ConnectedAccount): Promise<string> {
  const expMs = acct.expires_at ? new Date(acct.expires_at).getTime() : 0;
  if (expMs < Date.now() + 5 * 60 * 1000) {
    const refreshed = await doRefresh(acct.refresh_token);
    await updateAccountTokens(acct.id, refreshed);
    return refreshed.access_token;
  }
  return acct.access_token;
}

interface GoogleCalendarItem {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}
interface GoogleCalendarResponse {
  items?: GoogleCalendarItem[];
}

/** Read one account's primary-calendar events in [startISO, endISO), normalized. */
export async function googleCalendarEvents(
  acct: ConnectedAccount,
  startISO: string,
  endISO: string,
): Promise<NormalizedEvent[]> {
  const accessToken = await getValidAccessTokenForAccount(acct);
  const params = new URLSearchParams({
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Calendar ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as GoogleCalendarResponse;
  const who = acct.account_name || acct.account_email;
  return (data.items ?? []).map((it) => {
    const allDay = !!it.start?.date; // all-day events carry `date`, timed carry `dateTime`
    return {
      id: it.id,
      subject: it.summary || "(no title)",
      isAllDay: allDay,
      start: { dateTime: it.start?.dateTime || it.start?.date || "" },
      end: { dateTime: it.end?.dateTime || it.end?.date || "" },
      ...(it.location ? { location: { displayName: it.location } } : {}),
      account: who,
    };
  });
}
