import {
  listEvents,
  type CalEvent,
} from "./calendar";
import {
  helsinkiWallToUtc,
  utcToHelsinkiWall,
  wallDateString,
  parseHelsinkiDateTime,
} from "./timezone";

// Deterministic booking-rules engine. NOTHING here is AI-judged — every rule is
// computed in code so scheduling behavior is exact and reproducible.
//
// Rules (all in Europe/Helsinki wall time):
//   • Working window 08:00–18:00; the FULL estimated duration must fit before 18:00.
//   • No overlap with any existing timed event.
//   • Uusimaa: a 1-hour travel gap before/after neighbouring events.
//   • Max 5 cleaning appointments per day.

export const WORK_START_MIN = 8 * 60; // 08:00
export const WORK_END_MIN = 18 * 60; // 18:00
export const MAX_CLEANING_PER_DAY = 5;
export const UUSIMAA_GAP_MIN = 60;
const SLOT_INCREMENT_MIN = 30;
const SEARCH_SPAN_DAYS = 21; // how far forward to look for a slot

// Cleaning-related keywords used to count PRE-EXISTING calendar entries toward
// the daily cap.
//
// KNOWN LIMITATION (historical data): existing calendar entries are named
// inconsistently — some clearly cleaning-related, some clearly not (e.g. "Ilia
// meeting about…", "Pick up terminal…"). There is no fully reliable way to tell
// old entries apart by title alone, so this keyword match is a BEST-EFFORT
// heuristic for legacy events only. Every appointment THIS system creates going
// forward is tagged extendedProperties.private.source = "cleava-agent" (see
// lib/calendar.ts), so those are counted exactly (isCleavaAgent) regardless of
// title — the heuristic never applies to our own events.
const CLEANING_KEYWORDS = [
  "siivous",
  "kotisiivous",
  "muuttosiivous",
  "ikkunanpesu",
  "tehopuhdistus",
  "suursiivous",
];

export type Slot = {
  date: string; // "YYYY-MM-DD" (Helsinki)
  startTime: string; // "HH:MM" (Helsinki)
  endTime: string; // "HH:MM" (Helsinki)
  startInstant: Date;
  endInstant: Date;
};

/** True if an event counts as a cleaning appointment for the daily cap. */
export function isCleaningEvent(ev: CalEvent): boolean {
  // Our own tagged events are counted exactly — no heuristic.
  if (ev.isCleavaAgent) return true;
  const haystack = `${ev.summary} ${ev.description}`.toLowerCase();
  return CLEANING_KEYWORDS.some((kw) => haystack.includes(kw));
}

function minutesToTimeStr(min: number): string {
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mm = String(min % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Add whole days to a Helsinki date string (DST-safe via a noon anchor). */
function helsinkiDatePlusDays(dateStr: string, offset: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noon = helsinkiWallToUtc({ year: y, month: m, day: d, hour: 12, minute: 0 });
  const shifted = new Date(noon.getTime() + offset * 86_400_000);
  return wallDateString(utcToHelsinkiWall(shifted));
}

/** Count cleaning events that fall on a given Helsinki calendar day. */
export function countCleaningOnDay(dateStr: string, events: CalEvent[]): number {
  let count = 0;
  for (const ev of events) {
    if (!isCleaningEvent(ev)) continue;
    const wall = utcToHelsinkiWall(ev.start);
    if (wallDateString(wall) === dateStr) count++;
  }
  return count;
}

/**
 * Is the exact [start, end] interval free under overlap + Uusimaa-gap rules,
 * given the existing events? The gap is applied symmetrically around our slot
 * against ALL events (conservative: a neighbouring commitment of any kind needs
 * travel spacing in Uusimaa).
 */
export function isIntervalFree(
  startInstant: Date,
  endInstant: Date,
  isUusimaa: boolean,
  events: CalEvent[]
): boolean {
  const gapMs = (isUusimaa ? UUSIMAA_GAP_MIN : 0) * 60_000;
  const reqStart = startInstant.getTime() - gapMs;
  const reqEnd = endInstant.getTime() + gapMs;
  for (const ev of events) {
    // Overlap test: [reqStart, reqEnd) intersects [ev.start, ev.end)
    if (reqStart < ev.end.getTime() && ev.start.getTime() < reqEnd) {
      return false;
    }
  }
  return true;
}

// Build the concrete slot for a day + start-minute, or null if it doesn't fit
// the working window.
function buildSlot(
  dateStr: string,
  startMin: number,
  durationMin: number
): Slot | null {
  if (startMin < WORK_START_MIN) return null;
  const endMin = startMin + durationMin;
  if (endMin > WORK_END_MIN) return null; // full duration must fit before 18:00
  const startTime = minutesToTimeStr(startMin);
  const endTime = minutesToTimeStr(endMin);
  const startInstant = parseHelsinkiDateTime(dateStr, startTime);
  const endInstant = parseHelsinkiDateTime(dateStr, endTime);
  if (!startInstant || !endInstant) return null;
  return { date: dateStr, startTime, endTime, startInstant, endInstant };
}

/**
 * Pure nearest-slot search over an already-fetched event list.
 *
 * FORWARD-ONLY when a date was requested: we never propose a slot earlier than
 * the customer's requested day. If the requested day has no valid slot, we
 * search later days only (never back to an earlier day, even if an earlier slot
 * is closer in absolute time). The search is anchored at max(today, requested
 * day) and runs SEARCH_SPAN_DAYS forward from there. Among the searched days the
 * valid slot closest to `target` wins, so the requested day is preferred and
 * otherwise the soonest later day.
 *
 * When NO date was requested (`requested` is null — a fully open-ended request),
 * behavior is unchanged: anchor at today and pick the nearest upcoming slot.
 *
 * Never returns a slot in the past. Returns null if nothing fits.
 */
export function findNearestSlotPure(params: {
  durationHours: number;
  isUusimaa: boolean;
  requested: Date | null;
  now: Date;
  events: CalEvent[];
}): Slot | null {
  const { durationHours, isUusimaa, requested, now, events } = params;
  const durationMin = Math.ceil(durationHours * 60);
  if (durationMin <= 0 || durationMin > WORK_END_MIN - WORK_START_MIN) {
    return null; // can't fit in a single working day
  }

  const todayStr = wallDateString(utcToHelsinkiWall(now));
  // Anchor the search. With a requested date, never search before it (nor before
  // today — a past request can't be honoured): anchor = max(today, requested).
  // Without a requested date, anchor at today (nearest-from-now).
  let anchorStr = todayStr;
  if (requested != null) {
    const requestedStr = wallDateString(utcToHelsinkiWall(requested));
    anchorStr = requestedStr > todayStr ? requestedStr : todayStr;
  }
  const target = requested ?? now;

  let best: Slot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset <= SEARCH_SPAN_DAYS; offset++) {
    const dateStr = helsinkiDatePlusDays(anchorStr, offset);

    // Daily cleaning cap — skip the whole day if already full.
    if (countCleaningOnDay(dateStr, events) >= MAX_CLEANING_PER_DAY) continue;

    for (
      let startMin = WORK_START_MIN;
      startMin + durationMin <= WORK_END_MIN;
      startMin += SLOT_INCREMENT_MIN
    ) {
      const slot = buildSlot(dateStr, startMin, durationMin);
      if (!slot) continue;
      // Never in the past.
      if (slot.startInstant.getTime() <= now.getTime()) continue;
      if (!isIntervalFree(slot.startInstant, slot.endInstant, isUusimaa, events)) {
        continue;
      }
      const distance = Math.abs(slot.startInstant.getTime() - target.getTime());
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
  }

  return best;
}

/**
 * Fetch events for the search window and find the nearest available slot.
 * Orchestrates the Google call + the pure engine. Returns null when no slot
 * fits (or when duration is unknown upstream — caller should guard).
 */
export async function findNearestAvailableSlot(params: {
  durationHours: number;
  isUusimaa: boolean;
  requested: Date | null;
  now?: Date;
}): Promise<Slot | null> {
  const now = params.now ?? new Date();
  // Fetch a little before now through the end of the search span.
  const windowStart = new Date(now.getTime() - 60 * 60_000);
  const windowEnd = new Date(now.getTime() + (SEARCH_SPAN_DAYS + 2) * 86_400_000);
  const events = await listEvents(windowStart, windowEnd);
  return findNearestSlotPure({
    durationHours: params.durationHours,
    isUusimaa: params.isUusimaa,
    requested: params.requested,
    now,
    events,
  });
}

/**
 * Re-check that a specific, previously-proposed slot is still bookable (used at
 * approval time, since the calendar may have changed since quote generation).
 * Verifies the working window, the daily cleaning cap, and overlap + gap.
 */
export async function isSlotStillFree(params: {
  date: string;
  startTime: string;
  endTime: string;
  isUusimaa: boolean;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const startInstant = parseHelsinkiDateTime(params.date, params.startTime);
  const endInstant = parseHelsinkiDateTime(params.date, params.endTime);
  if (!startInstant || !endInstant) return false;
  if (startInstant.getTime() <= now.getTime()) return false; // in the past

  // Fetch a wide-enough window to cover the FULL Helsinki calendar day (needed
  // for the daily-cap count) plus the neighbouring-gap check. ±14h around a
  // 08:00–18:00 slot safely spans midnight-to-midnight of that day.
  const events = await listEvents(
    new Date(startInstant.getTime() - 14 * 60 * 60_000),
    new Date(endInstant.getTime() + 14 * 60 * 60_000)
  );

  // Daily cap (exclude our own already-placed event for this slot is not needed
  // here — we only place the hold once, guarded by calendar_event_id upstream).
  if (countCleaningOnDay(params.date, events) >= MAX_CLEANING_PER_DAY) {
    return false;
  }
  return isIntervalFree(startInstant, endInstant, params.isUusimaa, events);
}
