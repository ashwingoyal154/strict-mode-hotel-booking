/**
 * Foreign exchange, in integers only.
 *
 * A conversion is stored with the booking and must re-derive to the same minor
 * unit years later (A11), and a policy verdict that converts must replay
 * byte-identically (A12). A float anywhere in this path makes both a matter of
 * luck, so every multiplication and division here happens in BigInt, and the one
 * rounding step is half-to-even — the rounding that does not drift upward when
 * many conversions are summed.
 */

import type { Conversion, Currency, FxRate, IsoMonth, Money } from "./types.ts";
import { MINOR_UNIT_EXPONENTS, formatMoney, money } from "./money.ts";

/** Minor-unit exponent per ISO 4217 code; codes absent from the table use 2. */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = MINOR_UNIT_EXPONENTS;

/** The number of minor-unit digits a currency carries: JPY 0, INR 2, BHD 3; unknown codes 2. */
export function exponentOf(currency: Currency): number {
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Thrown when no pin, direct or inverse, links two currencies. Never chained through a third. */
export class NoFxPinError extends Error {
  readonly from: Currency;
  readonly to: Currency;

  constructor(from: Currency, to: Currency) {
    super(`No pinned FX rate for ${from}→${to}`);
    this.name = "NoFxPinError";
    this.from = from;
    this.to = to;
  }
}

/** Thrown when a rate is applied to an amount that is not in the rate's base currency. */
export class FxMismatchError extends Error {
  readonly expected: Currency;
  readonly received: Currency;

  constructor(expected: Currency, received: Currency) {
    super(`FX rate is quoted from ${expected} but the amount is ${received}`);
    this.name = "FxMismatchError";
    this.expected = expected;
    this.received = received;
  }
}

const MICROS = 1_000_000n;
const MICROS_SQUARED = 1_000_000_000_000n;

function pow10(exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i++) result *= 10n;
  return result;
}

/**
 * n ÷ d rounded half to even, for any sign of n and a positive d. BigInt division
 * truncates toward zero, so the magnitude is rounded and the sign reapplied —
 * that keeps −2.5 → −2 symmetric with 2.5 → 2.
 */
function divRoundHalfEven(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("Divisor must be positive");
  const negative = n < 0n;
  const magnitude = negative ? -n : n;
  let quotient = magnitude / d;
  const twiceRemainder = (magnitude % d) * 2n;
  if (twiceRemainder > d || (twiceRemainder === d && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Converted amount ${value.toString()} exceeds the safe integer range`);
  }
  return Number(value);
}

function assertRateMicros(rate: FxRate): void {
  if (!Number.isSafeInteger(rate.rateMicros) || rate.rateMicros <= 0) {
    throw new RangeError(
      `FX rate ${rate.base}→${rate.quote} must be a positive integer of micros, received ${String(rate.rateMicros)}`,
    );
  }
}

/**
 * Converts with one rate: to.minor = from.minor × rateMicros × 10^exp(quote) ÷
 * (10^6 × 10^exp(base)), rounded half to even. Throws FxMismatchError when the
 * amount is not in the rate's base currency.
 */
export function convert(amount: Money, rate: FxRate): Conversion {
  if (rate.base !== amount.currency) throw new FxMismatchError(rate.base, amount.currency);
  assertRateMicros(rate);
  const numerator = BigInt(amount.minor) * BigInt(rate.rateMicros) * pow10(exponentOf(rate.quote));
  const denominator = MICROS * pow10(exponentOf(rate.base));
  const minor = toSafeNumber(divRoundHalfEven(numerator, denominator));
  return { from: amount, to: money(minor, rate.quote), fx: rate };
}

/**
 * The inverse of a pin, keeping its provenance (source, month, asOf). The
 * returned rate is what actually produced the conversion, so storing it lets the
 * figure re-derive with a single `convert` — no second inversion to round.
 */
function invert(pin: FxRate): FxRate {
  assertRateMicros(pin);
  const micros = divRoundHalfEven(MICROS_SQUARED, BigInt(pin.rateMicros));
  if (micros === 0n) {
    throw new RangeError(`FX rate ${pin.base}→${pin.quote} is too large to invert at micro precision`);
  }
  return {
    base: pin.quote,
    quote: pin.base,
    rateMicros: toSafeNumber(micros),
    source: pin.source,
    pinMonth: pin.pinMonth,
    asOf: pin.asOf,
  };
}

/**
 * Converts using the supplied pins: `fx: null` for the same currency, else a
 * direct pin, else an inverted one; throws NoFxPinError otherwise. Never chains
 * through a third currency, because a chained rate is a rate nobody pinned.
 */
export function convertVia(amount: Money, to: Currency, pins: readonly FxRate[]): Conversion {
  if (amount.currency === to) return { from: amount, to: amount, fx: null };

  const direct = pins.find((p) => p.base === amount.currency && p.quote === to);
  if (direct !== undefined) return convert(amount, direct);

  const reverse = pins.find((p) => p.base === to && p.quote === amount.currency);
  if (reverse !== undefined) return convert(amount, invert(reverse));

  throw new NoFxPinError(amount.currency, to);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The UTC calendar month an instant falls in, e.g. "2026-09" — the key a monthly pin is filed under. */
export function pinMonthOf(at: Date): IsoMonth {
  const stamp = at.getTime();
  if (Number.isNaN(stamp)) throw new RangeError("pinMonthOf needs a valid Date");
  return `${String(at.getUTCFullYear()).padStart(4, "0")}-${pad2(at.getUTCMonth() + 1)}`;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "2026-09" → "Sep", from a fixed table: this label is inside stored reason strings, so no Intl. */
export function monthLabel(month: IsoMonth): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const label = match === null ? undefined : MONTH_LABELS[Number(match[2]) - 1];
  if (label === undefined) throw new RangeError(`Expected an ISO month (YYYY-MM), received "${month}"`);
  return label;
}

/**
 * A rate as one readable line, "1 GBP = ₹106.25 · Sep pinned". Micro precision is
 * kept (trailing zeros trimmed to at least two places) because an inverse rate
 * such as "1 INR = £0.009412" rounded to money precision would read as zero.
 */
export function formatRate(rate: FxRate): string {
  assertRateMicros(rate);
  const fraction = rate.rateMicros % 1_000_000;
  const whole = (rate.rateMicros - fraction) / 1_000_000;

  let digits = String(fraction).padStart(6, "0").replace(/0+$/, "");
  if (digits.length < 2) digits = digits.padEnd(2, "0");

  // formatMoney owns the symbol and the grouping (₹1,06,250 vs $106,250); the whole
  // part goes through it with a zero fraction, and the micro digits are appended.
  const wholeText = formatMoney(money(whole * 10 ** exponentOf(rate.quote), rate.quote));

  let suffix: string;
  if (rate.source === "spot") suffix = " · spot";
  else suffix = rate.pinMonth === null ? " · pinned" : ` · ${monthLabel(rate.pinMonth)} pinned`;

  return `1 ${rate.base} = ${wholeText}.${digits}${suffix}`;
}
