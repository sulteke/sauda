/**
 * Business-day boundaries.
 *
 * Daily limits (AI analyses, Telegram publications) reset at midnight in the
 * BUSINESS timezone, not UTC and not the server's local zone — a Vercel
 * function runs in UTC, which would roll the day over at 05:00 Almaty time.
 *
 * Implemented with `Intl.DateTimeFormat` only (no date library, no new
 * dependency). `now` is injectable everywhere so the rollover is testable.
 */

/** Default business timezone. Override with BUSINESS_TIMEZONE. */
export const DEFAULT_BUSINESS_TIMEZONE = "Asia/Almaty";

/** The configured business timezone, falling back to the default. */
export function businessTimeZone(): string {
  const configured = process.env.BUSINESS_TIMEZONE?.trim();
  return configured ? configured : DEFAULT_BUSINESS_TIMEZONE;
}

/**
 * Offset of `timeZone` from UTC at `date`, in ms (positive east of Greenwich).
 * Derived by formatting the instant in the target zone and reading the wall
 * clock back as if it were UTC — the difference is the offset, DST included.
 */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };

  const wallClockAsUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    // Some locales render midnight as "24" under hour12:false.
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  // Sub-second precision is irrelevant for a day boundary; drop it consistently.
  return wallClockAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which the business day containing `now` began (local midnight
 * in the business timezone), as a UTC Date suitable for a `gte` query.
 */
export function startOfBusinessDay(now: Date = new Date(), timeZone = businessTimeZone()): Date {
  const offsetMs = timeZoneOffsetMs(now, timeZone);
  const wallClock = new Date(now.getTime() + offsetMs);
  const wallClockMidnight = Date.UTC(
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate(),
  );
  return new Date(wallClockMidnight - offsetMs);
}

/** Calendar date of the business day containing `now`, as YYYY-MM-DD. */
export function businessDayKey(now: Date = new Date(), timeZone = businessTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
