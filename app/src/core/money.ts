/**
 * Money in integer minor units. Every arithmetic path here is integer-only:
 * floats cannot represent ₹8,700.35 exactly, and a cent of drift anywhere
 * breaks A3 ("the total never moves") and A12 (byte-identical replay).
 *
 * Formatting is the single place digits become a string, and it is
 * locale-independent by construction — no Intl.NumberFormat, because the
 * grouping of a stored reason string must never depend on the machine that
 * renders it.
 */

import type { Currency, Money } from "./types.ts";

/** Thrown whenever two amounts in different currencies are combined or compared. */
export class CurrencyMismatchError extends Error {
  readonly left: Currency;
  readonly right: Currency;

  constructor(left: Currency, right: Currency) {
    super(`Currency mismatch: ${left} and ${right} cannot be combined`);
    this.name = "CurrencyMismatchError";
    this.left = left;
    this.right = right;
  }
}

/** Builds a Money, rejecting non-integer minor units so no float can enter the system. */
export function money(minor: number, currency: Currency): Money {
  if (!Number.isInteger(minor)) {
    throw new RangeError(`Money.minor must be an integer, received ${String(minor)}`);
  }
  if (currency.length === 0) {
    throw new RangeError("Money.currency must be a non-empty ISO 4217 code");
  }
  return { minor, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

/** Sum of two amounts in the same currency; throws CurrencyMismatchError otherwise. */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

/** Difference a − b in the same currency; may be negative (overage arithmetic needs that). */
export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/**
 * Sum of a list in an explicitly named currency — the currency is a parameter so
 * an empty list still yields a typed zero rather than an untyped one.
 */
export function sumMoney(items: readonly Money[], currency: Currency): Money {
  let total = 0;
  for (const item of items) {
    if (item.currency !== currency) throw new CurrencyMismatchError(currency, item.currency);
    total += item.minor;
  }
  return money(total, currency);
}

/** Scales an amount by an integer factor; non-integer factors are rejected, never rounded. */
export function multiplyMoney(m: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new RangeError(`multiplyMoney expects an integer factor, received ${String(factor)}`);
  }
  return money(m.minor * factor, m.currency);
}

/** −1 / 0 / 1 ordering of two same-currency amounts; throws on a currency mismatch. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

/** Magnitude of an amount, same currency — "₹1,200 less" needs the size without the sign. */
export function absMoney(m: Money): Money {
  return money(Math.abs(m.minor), m.currency);
}

/** True for exactly zero minor units; a currency is still required, so zero is never untyped. */
export function isZeroMoney(m: Money): boolean {
  return m.minor === 0;
}

/**
 * ISO 4217 minor-unit exponents that differ from, or matter as much as, the
 * default of 2. `core/fx.ts` re-exports this as CURRENCY_EXPONENT; it lives here
 * because formatting must agree with conversion, and fx.ts already depends on
 * this module — defining it once in fx.ts would make the two import each other.
 */
export const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
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

function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.toUpperCase()] ?? 2;
}

const SYMBOLS: Readonly<Record<string, string>> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  AED: "AED",
  SGD: "S$",
};

/** Groups an integer-digit string Western-style: 1,240,000. */
function groupWestern(digits: string): string {
  let out = "";
  let seen = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    out = digits.charAt(i) + out;
    seen += 1;
    if (seen % 3 === 0 && i > 0) out = `,${out}`;
  }
  return out;
}

/** Groups Indian-style: last three digits, then pairs — 1,34,800 (one lakh thirty-four thousand). */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, digits.length - 3);
  const tail = digits.slice(digits.length - 3);
  let out = "";
  let seen = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    out = head.charAt(i) + out;
    seen += 1;
    if (seen % 2 === 0 && i > 0) out = `,${out}`;
  }
  return `${out},${tail}`;
}

/**
 * Renders an amount exactly as it appears in stored reason strings and the UI:
 * ₹1,34,800 for INR (lakh grouping), $1,240 elsewhere. `decimals: true` forces
 * the paise/cents to show; by default they appear only when non-zero, so the
 * flag can only add precision, never hide money that exists.
 */
export function formatMoney(m: Money, opts?: { decimals?: boolean }): string {
  const code = m.currency.toUpperCase();
  const symbol = SYMBOLS[code] ?? code;
  // An alphabetic symbol ("AED") needs a space; a glyph ("₹", "S$") must not have one.
  const separator = /[A-Za-z]$/.test(symbol) ? " " : "";

  const negative = m.minor < 0;
  const abs = Math.abs(m.minor);
  // Slice 2 goes abroad: ¥1,240 has no sen and BHD has fils in thousandths, so the
  // split point comes from the currency. (abs − fraction) ÷ divisor is an exact
  // integer division, where abs ÷ divisor would pass through a float.
  const exponent = minorUnitExponent(code);
  const divisor = 10 ** exponent;
  const fraction = abs % divisor;
  const majorDigits = String((abs - fraction) / divisor);

  const grouped = code === "INR" ? groupIndian(majorDigits) : groupWestern(majorDigits);
  const showFraction = exponent > 0 && (opts?.decimals === true || fraction !== 0);
  const body = showFraction ? `${grouped}.${String(fraction).padStart(exponent, "0")}` : grouped;

  return `${negative ? "-" : ""}${symbol}${separator}${body}`;
}
