/**
 * Presentation formatting for the Verdict language.
 *
 * Self-contained on purpose: `src/core/money.ts` and `src/core/format.ts` are
 * being written by another stream in parallel, so the web bundle must not take a
 * hard dependency on files that may not exist yet. The rules here mirror the
 * frozen signatures in MODULE_EXPORTS.md so the two agree on output.
 *
 * Nothing here recomputes money. `formatMoney` renders a Money the server sent;
 * it never derives a total.
 */

import type { Commute, IsoDate, IsoDateTime, Money, Rate, RateComponent } from "../../core/types.ts";

// ---------- money ----------

const SYMBOLS: Readonly<Record<string, string>> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "AED ",
  SGD: "S$",
};

function symbolFor(currency: string): string {
  const found = SYMBOLS[currency];
  return found === undefined ? `${currency} ` : found;
}

function groupWestern(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1,23,45,678 — last three, then pairs. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}`;
}

/** Minor units are hidden unless non-zero, unless `decimals` forces the issue. */
export function formatMoney(m: Money, opts?: { decimals?: boolean }): string {
  const rounded = Math.round(m.minor);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const major = Math.floor(abs / 100);
  const fraction = abs % 100;
  const withDecimals = opts?.decimals ?? fraction !== 0;
  const digits = String(major);
  const grouped = m.currency === "INR" ? groupIndian(digits) : groupWestern(digits);
  const tail = withDecimals ? `.${String(fraction).padStart(2, "0")}` : "";
  return `${negative ? "−" : ""}${symbolFor(m.currency)}${grouped}${tail}`;
}

/** A signed amount, for deltas. `+₹700` / `−₹700`. */
export function formatSignedMinor(minor: number, currency: string): string {
  const sign = minor > 0 ? "+" : minor < 0 ? "−" : "";
  return `${sign}${formatMoney({ minor: Math.abs(minor), currency })}`;
}

// ---------- dates ----------

const MONTHS: readonly string[] = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface YMD {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function parseIsoDate(value: IsoDate): YMD | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) return null;
  return { y: Number(y), m: Number(m), d: Number(d) };
}

function monthName(month1: number): string {
  return MONTHS[month1 - 1] ?? "";
}

/** "11–15 Jun", or "29 Jun – 2 Jul" across a month boundary. */
export function formatDateRange(checkIn: IsoDate, checkOut: IsoDate): string {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (a === null || b === null) return `${checkIn} – ${checkOut}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${monthName(a.m)}`;
  return `${a.d} ${monthName(a.m)} – ${b.d} ${monthName(b.m)}`;
}

export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (a === null || b === null) return 0;
  const msA = Date.UTC(a.y, a.m - 1, a.d);
  const msB = Date.UTC(b.y, b.m - 1, b.d);
  return Math.max(0, Math.round((msB - msA) / 86_400_000));
}

/** "Jun" — for the anchor chips. */
export function monthOf(checkIn: IsoDate): string {
  const a = parseIsoDate(checkIn);
  return a === null ? "" : monthName(a.m);
}

/** "6:00 pm, Sat 14 Jun" in the traveller's local zone unless one is given. */
export function formatDeadline(iso: IsoDateTime, timeZone?: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    weekday: "short",
    day: "numeric",
    month: "short",
  };
  if (timeZone !== undefined) opts.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(dt);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const period = pick("dayPeriod").toLowerCase().replace(/\./g, "").replace(/\s/g, "");
  return `${pick("hour")}:${pick("minute")} ${period}, ${pick("weekday")} ${pick("day")} ${pick("month")}`;
}

/** "11 Jun 2026, 4:05 pm" — for records, not deadlines. */
export function formatStamp(iso: IsoDateTime): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(dt);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const period = pick("dayPeriod").toLowerCase().replace(/\./g, "").replace(/\s/g, "");
  return `${pick("day")} ${pick("month")} ${pick("year")}, ${pick("hour")}:${pick("minute")} ${period}`;
}

export function todayIso(): IsoDate {
  return isoFromLocal(new Date());
}

export function isoFromLocal(dt: Date): IsoDate {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysIso(value: IsoDate, days: number): IsoDate {
  const a = parseIsoDate(value);
  if (a === null) return value;
  const dt = new Date(Date.UTC(a.y, a.m - 1, a.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------- durations ----------

/** "840ms" / "1.2s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "2d 14h 06m" / "14h 06m" / "06m 12s" / "closed" */
export function formatCountdown(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return "closed";
  const totalSeconds = Math.floor(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${pad(minutes)}m ${pad(seconds)}s`;
}

// ---------- domain strings ----------

/** "7 min walk" */
export function describeCommute(c: Commute): string {
  return `${c.minutes} min ${c.mode}`;
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}

/** "all-in, 4 nights · ₹8,700/night" */
export function perNightLine(rate: Rate): string {
  return `all-in, ${plural(rate.nights, "night")} · ${formatMoney(rate.perNight)}/night`;
}

export interface RateBreakdown {
  readonly rows: readonly { kind: RateComponent["kind"]; label: string; amount: Money }[];
  readonly total: Money;
}

const KIND_ORDER: Readonly<Record<RateComponent["kind"], number>> = { base: 0, tax: 1, fee: 2 };

/** Component rows in base → tax → fee order. Never re-sums into a new total. */
export function rateBreakdown(rate: Rate): RateBreakdown {
  const rows = [...rate.components]
    .map((c) => ({ kind: c.kind, label: c.label, amount: c.amount }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return { rows, total: rate.allInTotal };
}

export function mapsHref(lat: number, lng: number, label: string): string {
  const q = encodeURIComponent(`${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(label)}`;
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}

/** "14 Jun" — the short form used inside chips. */
export function formatDayMonth(iso: IsoDateTime): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).formatToParts(dt);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("day")} ${pick("month")}`;
}
