/**
 * Wall-clock helpers for the server's decisions that are about *places*: when a
 * stay's checkout has passed in the hotel's own time zone, what "today" is for
 * the duty-of-care view. Intl is used only to shift instants between zones.
 */

import type { IsoDate } from "../core/types.ts";

/** Standard hotel checkout. A stay is settled, and invoiced, after this instant. */
export const CHECKOUT_HOUR = 12;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a local wall-clock time happens in `timeZone`. Unknown zones fall back to UTC. */
export function zonedInstant(date: IsoDate, hour: number, minute: number, timeZone: string): Date {
  const m = ISO_DATE.exec(date);
  if (m === null) throw new RangeError(`Expected an ISO date, received "${date}"`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  try {
    const first = offsetMs(guess, timeZone);
    let t = guess - first;
    const second = offsetMs(t, timeZone);
    if (second !== first) t = guess - second;
    return new Date(t);
  } catch {
    return new Date(guess);
  }
}

export function checkoutInstant(checkOut: IsoDate, timeZone: string | undefined): Date {
  return zonedInstant(checkOut, CHECKOUT_HOUR, 0, timeZone ?? "Asia/Kolkata");
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const m = ISO_DATE.exec(date);
  if (m === null) throw new RangeError(`Expected an ISO date, received "${date}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Calendar date of `now` in `timeZone`, as YYYY-MM-DD. */
export function dateIn(now: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
