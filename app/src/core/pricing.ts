/**
 * The arithmetic behind "one number that never moves".
 *
 * A rate's components are not decoration: A10 requires tax to be an itemised
 * line that sums exactly to the all-in total, and A3 requires the number on the
 * results screen to equal the number on the invoice to the cent. Both are
 * enforced here by refusing to let an inconsistent Rate travel further.
 */

import type { Money, PriceDriftDetail, Rate, RateComponent } from "./types.ts";
import { addMoney, formatMoney, money, subMoney, sumMoney } from "./money.ts";

/** Thrown when a rate's parts do not add up to its whole — never swallowed, never corrected. */
export class PricingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingIntegrityError";
  }
}

/**
 * Sum of rate components. The currency is taken from the first component, so an
 * empty list is an error rather than a silent zero of unknown currency.
 */
export function componentsSum(components: readonly RateComponent[]): Money {
  const first = components[0];
  if (first === undefined) {
    throw new PricingIntegrityError("A rate must carry at least one component");
  }
  return sumMoney(
    components.map((c) => c.amount),
    first.amount.currency,
  );
}

/** Throws PricingIntegrityError unless the components sum exactly to `rate.allInTotal`. */
export function assertComponentsSum(rate: Rate): void {
  if (rate.allInTotal.currency !== rate.currency) {
    throw new PricingIntegrityError(
      `Rate ${rate.id}: allInTotal is ${rate.allInTotal.currency} but the rate is ${rate.currency}`,
    );
  }
  for (const component of rate.components) {
    if (component.amount.currency !== rate.currency) {
      throw new PricingIntegrityError(
        `Rate ${rate.id}: component "${component.label}" is ${component.amount.currency} but the rate is ${rate.currency}`,
      );
    }
  }
  const sum = componentsSum(rate.components);
  if (sum.minor !== rate.allInTotal.minor) {
    throw new PricingIntegrityError(
      `Rate ${rate.id}: components sum to ${formatMoney(sum, { decimals: true })} but allInTotal is ${formatMoney(rate.allInTotal, { decimals: true })}`,
    );
  }
}

/**
 * Per-night figure derived from the stay total, floored. The remainder stays in
 * the total — per-night is a display aid, the total is what is charged, so
 * rounding must never invent money that is not owed.
 */
export function perNightFrom(total: Money, nights: number): Money {
  if (!Number.isInteger(nights) || nights < 1) {
    throw new PricingIntegrityError(`A stay must be at least one night, received ${String(nights)}`);
  }
  return money(Math.floor(total.minor / nights), total.currency);
}

/** Splits a rate into base / taxes / fees plus the authoritative all-in total. */
export function breakdown(rate: Rate): { base: Money; taxes: Money; fees: Money; total: Money } {
  let base = money(0, rate.currency);
  let taxes = money(0, rate.currency);
  let fees = money(0, rate.currency);

  for (const component of rate.components) {
    if (component.kind === "base") base = addMoney(base, component.amount);
    else if (component.kind === "tax") taxes = addMoney(taxes, component.amount);
    else fees = addMoney(fees, component.amount);
  }

  // `total` is the stored all-in, not the recomputed sum: the stored figure is
  // the promise made to the traveller. assertComponentsSum is what proves they agree.
  return { base, taxes, fees, total: rate.allInTotal };
}

/** True only when both amounts are the same currency and the same minor units. */
export function totalsEqual(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/**
 * Describes the gap between the total the traveller accepted and the total the
 * source now quotes; null when they are identical. Non-null means a re-confirm,
 * never a silent adjustment.
 */
export function driftBetween(accepted: Money, current: Money): PriceDriftDetail | null {
  if (totalsEqual(accepted, current)) return null;

  const delta = subMoney(current, accepted);
  const direction = delta.minor > 0 ? "more" : "less";
  const magnitude = money(Math.abs(delta.minor), delta.currency);

  return {
    kind: "price_drift",
    acceptedTotal: accepted,
    currentTotal: current,
    deltaMinor: delta.minor,
    message: `This rate moved from ${formatMoney(accepted)} to ${formatMoney(current)} — ${formatMoney(magnitude)} ${direction} than you accepted`,
  };
}
