import { google, calendar_v3 } from "googleapis";
import { HELSINKI_TZ } from "./timezone";

// Google Calendar client, authenticated as a service account.
//
// The service-account JSON is provided base64-encoded via
// GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 (never the raw JSON in the repo — same
// pattern as ADMIN_PASSWORD_HASH). The target calendar must be SHARED with the
// service account's client_email ("Make changes to events"); with a shared
// calendar no domain-wide delegation is needed.

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

// Our own appointments carry this marker so future counting by our code is
// exact rather than keyword-heuristic (see lib/booking.ts).
export const CLEAVA_SOURCE_KEY = "source";
export const CLEAVA_SOURCE_VALUE = "cleava-agent";

type ServiceAccountCreds = {
  client_email: string;
  private_key: string;
};

let cachedClient: calendar_v3.Calendar | null = null;

function decodeCredentials(): ServiceAccountCreds {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!b64) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 environment variable."
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (err) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const creds = json as Partial<ServiceAccountCreds>;
  if (!creds.client_email || !creds.private_key) {
    throw new Error(
      "Service account JSON missing client_email or private_key."
    );
  }
  return { client_email: creds.client_email, private_key: creds.private_key };
}

export function getCalendarId(): string {
  const id = process.env.GOOGLE_CALENDAR_ID;
  if (!id) {
    throw new Error("Missing GOOGLE_CALENDAR_ID environment variable.");
  }
  return id;
}

/** Lazily build the authenticated Calendar client. */
export function getCalendar(): calendar_v3.Calendar {
  if (cachedClient) return cachedClient;
  const creds = decodeCredentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    // The PEM often arrives with literal "\n" — normalize to real newlines.
    key: creds.private_key.replace(/\\n/g, "\n"),
    scopes: [CALENDAR_SCOPE],
  });
  cachedClient = google.calendar({ version: "v3", auth });
  return cachedClient;
}

// A normalized timed event: instants (UTC) for start/end plus the raw title /
// description / marker used by the booking rules. All-day events (date, no
// dateTime) are skipped — the booking window is time-based.
export type CalEvent = {
  id: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  isCleavaAgent: boolean;
};

/**
 * List timed events on the configured calendar between two instants.
 * `singleEvents` expands recurring events; results come back time-ordered.
 */
export async function listEvents(
  timeMin: Date,
  timeMax: Date
): Promise<CalEvent[]> {
  const calendar = getCalendar();
  const res = await calendar.events.list({
    calendarId: getCalendarId(),
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const items = res.data.items ?? [];
  const events: CalEvent[] = [];
  for (const ev of items) {
    // Skip all-day events (they use `date`, not `dateTime`) and cancelled ones.
    const startStr = ev.start?.dateTime;
    const endStr = ev.end?.dateTime;
    if (!startStr || !endStr) continue;
    if (ev.status === "cancelled") continue;

    const priv = ev.extendedProperties?.private ?? {};
    events.push({
      id: ev.id ?? "",
      summary: ev.summary ?? "",
      description: ev.description ?? "",
      start: new Date(startStr),
      end: new Date(endStr),
      isCleavaAgent: priv[CLEAVA_SOURCE_KEY] === CLEAVA_SOURCE_VALUE,
    });
  }
  return events;
}

export type CreateEventInput = {
  summary: string;
  description?: string;
  // Helsinki wall-clock strings, e.g. "2026-07-25" and "10:00".
  date: string;
  startTime: string;
  endTime: string;
};

/**
 * Create a timed event on the configured calendar, tagged with the
 * source: cleava-agent marker. Times are given as Helsinki wall-clock and sent
 * with timeZone Europe/Helsinki so Google anchors them correctly (incl. DST).
 * Returns the created event id.
 */
export async function createTaggedEvent(
  input: CreateEventInput
): Promise<string> {
  const calendar = getCalendar();
  const res = await calendar.events.insert({
    calendarId: getCalendarId(),
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: {
        dateTime: `${input.date}T${input.startTime}:00`,
        timeZone: HELSINKI_TZ,
      },
      end: {
        dateTime: `${input.date}T${input.endTime}:00`,
        timeZone: HELSINKI_TZ,
      },
      extendedProperties: {
        private: { [CLEAVA_SOURCE_KEY]: CLEAVA_SOURCE_VALUE },
      },
    },
  });
  const id = res.data.id;
  if (!id) throw new Error("Calendar event creation returned no id.");
  return id;
}
