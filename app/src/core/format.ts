/**
 * Display formatting for dates, deadlines and durations.
 *
 * Month and weekday names are hard-coded rather than taken from Intl's locale
 * data: the strings here end up in stored records and screenshots, and a host
 * whose default locale is not English must not change them. Intl is used only
 * to shift an instant into a time zone — the arithmetic, never the wording.
 */

import type { IsoDate, IsoDateTime } from "./types.ts";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** India is the launch market, so an unqualified deadline is IST (§2.5: traveller-local). */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

/** En dash, not a hyphen: this is a range, and the glyph is part of the design. */
const EN_DASH = "–";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

function parseIsoDate(value: IsoDate): CalendarDate {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    throw new RangeError(`Expected an ISO date (YYYY-MM-DD), received "${value}"`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function monthName(month: number): string {
  const name = MONTHS[month - 1];
  if (name === undefined) throw new RangeError(`Month out of range: ${String(month)}`);
  return name;
}

function weekdayName(d: CalendarDate): string {
  const index = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  const name = WEEKDAYS[index];
  if (name === undefined) throw new RangeError(`Weekday out of range: ${String(index)}`);
  return name;
}

/**
 * A stay as one compact phrase: "11–15 Jun" inside a month, "29 Jun–2 Jul"
 * across months, with years added only when the range crosses one.
 */
export function formatDateRange(checkIn: IsoDate, checkOut: IsoDate): string {
  const from = parseIsoDate(checkIn);
  const to = parseIsoDate(checkOut);

  if (from.year !== to.year) {
    return `${from.day} ${monthName(from.month)} ${from.year}${EN_DASH}${to.day} ${monthName(to.month)} ${to.year}`;
  }
  if (from.month !== to.month) {
    return `${from.day} ${monthName(from.month)}${EN_DASH}${to.day} ${monthName(to.month)}`;
  }
  return `${from.day}${EN_DASH}${to.day} ${monthName(from.month)}`;
}

/** Reads a zone-shifted wall-clock out of an instant without trusting locale wording. */
function wallClockIn(iso: IsoDateTime, timeZone: string): CalendarDate & { hour: number; minute: number } {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) {
    throw new RangeError(`Expected an ISO date-time, received "${iso}"`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(stamp));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new RangeError(`Time zone "${timeZone}" produced no ${type}`);
    return Number(part.value);
  };

  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
  };
}

/**
 * A free-cancellation deadline in the traveller's own clock, e.g.
 * "6:00 pm, Sat 14 Jun" — the date is spelled out because a deadline the
 * traveller mis-reads costs them the refund.
 */
export function formatDeadline(iso: IsoDateTime, timeZone: string = DEFAULT_TIME_ZONE): string {
  const w = wallClockIn(iso, timeZone);
  const meridiem = w.hour < 12 ? "am" : "pm";
  // 0 and 12 both render as 12 — "0:00 am" is not a time anybody writes.
  const hour12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const minute = String(w.minute).padStart(2, "0");

  return `${hour12}:${minute} ${meridiem}, ${weekdayName(w)} ${w.day} ${monthName(w.month)}`;
}

/**
 * An approval SLA countdown in machine voice: "1h 42m left", "12m left",
 * "overdue by 7m". Minutes round up in both directions, so the line never says
 * "0m left" while time remains and never calls a breach "overdue by 0m".
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError(`formatRemaining needs a finite number of ms`);
  const overdue = ms < 0;
  const minutes = Math.ceil(Math.abs(ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const span = hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  return overdue ? `overdue by ${span}` : `${span} left`;
}

/** A measured duration for the source meter: "840ms", "1.2s", "1m 4s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError(`formatDuration needs a finite number of ms`);

  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);

  // Branch on the rounded figure, so 999.6ms reads "1.0s" and never "1000ms".
  const roundedMs = Math.round(abs);
  if (roundedMs < 1000) return `${sign}${roundedMs}ms`;
  if (roundedMs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;

  const totalSeconds = Math.round(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${minutes}m ${seconds}s`;
}
