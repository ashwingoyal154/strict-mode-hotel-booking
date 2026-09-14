/**
 * Formatting the approver and admin surfaces need beyond `lib/fmt.ts`: exact
 * decimal ↔ integer conversion, clock times, SLA durations and IST dates.
 *
 * Decimal parsing is string arithmetic throughout. `parseFloat("106.25") * 1e6`
 * is not guaranteed to be an integer, and an FX rate or a cap that is off by one
 * micro-unit silently changes verdicts.
 */

import type { Currency, IsoDate, IsoDateTime, IsoMonth } from "../../../core/types.ts";

// ---------- currencies ----------

const SYMBOLS: Readonly<Record<string, string>> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "AED ",
  SGD: "S$",
};

export function currencySymbol(c: Currency): string {
  return SYMBOLS[c] ?? `${c} `;
}

/** ISO 4217 minor-unit exponents that are not 2. */
const EXPONENTS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export function exponentOf(c: Currency): number {
  return EXPONENTS[c] ?? 2;
}

export function isCurrencyCode(v: string): boolean {
  return /^[A-Z]{3}$/.test(v);
}

// ---------- exact decimals ----------

export type Parsed = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string };

/**
 * "106.25" at scale 6 → 106250000. Rejects anything that is not a plain
 * non-negative decimal, and rejects more fractional digits than the scale holds
 * rather than rounding them away.
 */
export function parseScaled(input: string, scale: number, what: string): Parsed {
  const s = input.trim().replace(/,/g, "");
  if (s.length === 0) return { ok: false, error: `Enter ${what}.` };
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (m === null) return { ok: false, error: `${what} must be a plain number, like 106.25.` };
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > scale) {
    return {
      ok: false,
      error:
        scale === 0
          ? `${what} takes no decimal places.`
          : `${what} takes at most ${scale} decimal place${scale === 1 ? "" : "s"}.`,
    };
  }
  const digits = `${whole}${frac.padEnd(scale, "0")}`;
  const big = BigInt(digits);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: `${what} is too large.` };
  return { ok: true, value: Number(big) };
}

/** 106250000 at scale 6 → "106.25" (at least `minFrac` decimals, trailing zeros trimmed). */
export function formatScaled(value: number, scale: number, minFrac = 0): string {
  if (!Number.isSafeInteger(value)) return String(value);
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  let frac = scale === 0 ? "" : digits.slice(-scale);
  while (frac.length > minFrac && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${negative ? "−" : ""}${whole}${frac.length > 0 ? `.${frac}` : ""}`;
}

export function minorToDecimal(minor: number, currency: Currency): string {
  const exp = exponentOf(currency);
  return formatScaled(minor, exp, exp === 0 ? 0 : exp);
}

export function decimalToMinor(input: string, currency: Currency, what: string): Parsed {
  return parseScaled(input, exponentOf(currency), what);
}

function groupDigits(whole: string, currency: Currency): string {
  if (currency !== "INR") return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (whole.length <= 3) return whole;
  return `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
}

/** `1 GBP = ₹106.25`, exact to the micro. */
export function formatRate(base: Currency, quote: Currency, rateMicros: number): string {
  const dec = formatScaled(rateMicros, 6, 2);
  const [whole = "0", frac] = dec.split(".");
  const grouped = groupDigits(whole, quote);
  return `1 ${base} = ${currencySymbol(quote)}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

/** 0.824 → "82.4%". A value above 1 is read as already a percentage. */
export function formatRatio(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no data";
  const pct = v <= 1 ? v * 100 : v;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

// ---------- time ----------

function partsOf(dt: Date, opts: Intl.DateTimeFormatOptions): (t: Intl.DateTimeFormatPartTypes) => string {
  const parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(dt);
  return (t) => parts.find((p) => p.type === t)?.value ?? "";
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "4:10 pm" today, "4:10 pm Sat 14 Sep" otherwise. Viewer's local zone. */
export function formatClock(iso: IsoDateTime, now: number = Date.now()): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const pick = partsOf(dt, { hour: "numeric", minute: "2-digit", hour12: true });
  const period = pick("dayPeriod").toLowerCase().replace(/[.\s]/g, "");
  const clock = `${pick("hour")}:${pick("minute")} ${period}`;
  if (sameLocalDay(dt, new Date(now))) return clock;
  const day = partsOf(dt, { weekday: "short", day: "numeric", month: "short" });
  return `${clock} ${day("weekday")} ${day("day")} ${day("month")}`;
}

/** Minute resolution, because the SLA line never ticks faster than once a minute. */
export function formatSpan(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(Math.abs(ms) / 60_000));
  if (totalMinutes < 1) return "under 1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

const IST = "Asia/Kolkata";

/** Today's date in Asia/Kolkata, which is the contract's default for in-market. */
export function todayInKolkata(now: number = Date.now()): IsoDate {
  const pick = partsOf(new Date(now), { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function monthInKolkata(now: number = Date.now()): IsoMonth {
  return todayInKolkata(now).slice(0, 7);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" → "Sep 2026". */
export function formatMonth(month: IsoMonth): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return month;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "Rahul Mehta" → "Rahul". */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first === undefined || first.length === 0 ? name : first;
}
