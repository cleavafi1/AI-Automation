// Europe/Helsinki wall-clock ⇆ UTC-instant helpers.
//
// All booking math is done in Helsinki local time (EET/EEST) regardless of the
// server's or the calendar's display timezone. We avoid pulling in a date
// library by deriving the zone offset from Intl at the relevant instant, which
// handles DST transitions correctly.

export const HELSINKI_TZ = "Europe/Helsinki";

export type WallClock = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
};

// Minutes that `tz` is ahead of UTC at the given instant (e.g. +120 for EET,
// +180 for EEST). Derived by formatting the instant in the zone and diffing.
function tzOffsetMinutes(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  // Intl formats hour "24" for midnight in some engines — normalize.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asUTC = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    hour,
    map.minute,
    map.second
  );
  return (asUTC - instant.getTime()) / 60000;
}

/**
 * Convert a Helsinki wall-clock time to the corresponding UTC instant.
 * Runs the offset correction twice so instants near a DST boundary resolve to
 * the correct offset.
 */
export function helsinkiWallToUtc(wall: WallClock): Date {
  const naiveUTC = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute
  );
  let offset = tzOffsetMinutes(new Date(naiveUTC), HELSINKI_TZ);
  let instant = naiveUTC - offset * 60000;
  offset = tzOffsetMinutes(new Date(instant), HELSINKI_TZ);
  instant = naiveUTC - offset * 60000;
  return new Date(instant);
}

/** Read the Helsinki wall-clock representation of a UTC instant. */
export function utcToHelsinkiWall(instant: Date): WallClock {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: HELSINKI_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = Number(p.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
  };
}

/** "YYYY-MM-DD" for a Helsinki wall-clock. */
export function wallDateString(wall: WallClock): string {
  const mm = String(wall.month).padStart(2, "0");
  const dd = String(wall.day).padStart(2, "0");
  return `${wall.year}-${mm}-${dd}`;
}

/** "HH:MM" for a Helsinki wall-clock. */
export function wallTimeString(wall: WallClock): string {
  const hh = String(wall.hour).padStart(2, "0");
  const mm = String(wall.minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Minutes since midnight for a Helsinki wall-clock (used for window checks). */
export function wallMinutes(wall: WallClock): number {
  return wall.hour * 60 + wall.minute;
}

/** Today's Helsinki calendar date as "YYYY-MM-DD" (for prompts / defaults). */
export function helsinkiTodayString(now: Date = new Date()): string {
  return wallDateString(utcToHelsinkiWall(now));
}

/** Normalize a time string to "HH:MM" (accepts "H:MM", "HH:MM", "HH:MM:SS"). */
export function normalizeHHMM(timeStr: string): string | null {
  const tm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(timeStr.trim());
  if (!tm) return null;
  return `${tm[1].padStart(2, "0")}:${tm[2]}`;
}

/** Parse "YYYY-MM-DD" + a time (Helsinki wall) into a UTC instant. */
export function parseHelsinkiDateTime(
  dateStr: string,
  timeStr: string
): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const hhmm = normalizeHHMM(timeStr);
  if (!dm || !hhmm) return null;
  const [h, mi] = hhmm.split(":");
  return helsinkiWallToUtc({
    year: Number(dm[1]),
    month: Number(dm[2]),
    day: Number(dm[3]),
    hour: Number(h),
    minute: Number(mi),
  });
}
