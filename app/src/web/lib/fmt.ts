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

// ---------- Slice 2: time as a first-class value ----------

function pickParts(dt: Date, opts: Intl.DateTimeFormatOptions): (t: Intl.DateTimeFormatPartTypes) => string {
  const parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(dt);
  return (type) => parts.find((p) => p.type === type)?.value ?? "";
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** "4:10 pm" today, "4:10 pm Tue 15 Sep" on any other day. The traveller's local zone. */
export function formatClock(iso: IsoDateTime, now: Date = new Date()): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const pick = pickParts(dt, { hour: "numeric", minute: "2-digit", hour12: true });
  const period = pick("dayPeriod").toLowerCase().replace(/\./g, "").replace(/\s/g, "");
  const clock = `${pick("hour")}:${pick("minute")} ${period}`;
  if (sameLocalDay(dt, now)) return clock;
  const day = pickParts(dt, { weekday: "short", day: "numeric", month: "short" });
  return `${clock} ${day("weekday")} ${day("day")} ${day("month")}`;
}

/**
 * Minute precision, because the SLA line never ticks faster than once a minute.
 * "1h 42m left" · "12m left" · "under 1m left" · "overdue by 7m".
 * Mirrors `formatRemaining` in core/format.ts.
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const overdue = ms < 0;
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  let span: string;
  if (days > 0) span = `${days}d ${hours}h`;
  else if (hours > 0) span = `${hours}h ${String(mins).padStart(2, "0")}m`;
  else span = `${mins}m`;
  if (overdue) return minutes < 1 ? "overdue by under 1m" : `overdue by ${span}`;
  return minutes < 1 ? "under 1m left" : `${span} left`;
}

/** "2h" / "90m" / "1d" — a policy duration, not a countdown. */
export function formatMinutesSpan(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${minutes}m`;
}

const MONTHS_LONG: readonly string[] = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09" → "Sep" (or "September" with `long`). A rate with no date is a guess. */
export function pinMonthName(month: string, long = false): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const m = match?.[2];
  if (m === undefined) return month;
  const i = Number(m) - 1;
  return (long ? MONTHS_LONG[i] : MONTHS[i]) ?? month;
}

// ---------- Slice 2: money ----------

/** `+₹2,400` / `−₹1,200` / `₹0`, from a signed Money the server sent. */
export function formatSignedMoney(m: Money, opts?: { decimals?: boolean }): string {
  const sign = m.minor > 0 ? "+" : m.minor < 0 ? "−" : "";
  return `${sign}${formatMoney({ minor: Math.abs(m.minor), currency: m.currency }, opts)}`;
}

export function formatPercent(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

// ---------- Slice 2: tax documents ----------

/** GST state codes, for place of supply by state name. */
export const GST_STATE_NAMES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

/** "Maharashtra (27)". An unknown code is shown as the code, never guessed. */
export function stateLabel(code: string | null): string {
  if (code === null) return "–";
  const name = GST_STATE_NAMES[code];
  return name === undefined ? `state code ${code}` : `${name} (${code})`;
}

/**
 * Turns a server reason into the tail of a verdict sentence:
 * "The 5% slab carries no input tax credit" → "the 5% slab carries no input tax credit."
 * An initialism ("GST …") keeps its capitals.
 */
export function sentenceTail(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return trimmed;
  const first = trimmed.charAt(0);
  const second = trimmed.charAt(1);
  const lowered =
    second !== "" && second === second.toLowerCase() && second !== second.toUpperCase()
      ? `${first.toLowerCase()}${trimmed.slice(1)}`
      : trimmed;
  return /[.!?]$/.test(lowered) ? lowered : `${lowered}.`;
}

/** "pending_approval" → "pending approval". Machine voice, no underscores on screen. */
export function stateWords(state: string): string {
  return state.replace(/_/g, " ");
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
