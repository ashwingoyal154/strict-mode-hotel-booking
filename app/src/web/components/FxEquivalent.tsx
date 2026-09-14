/**
 * FxEquivalent — `≈ ₹1,75,100 · Sep pinned rate`.
 *
 * Abroad, the supplier currency is the number the hotel charges, so it leads at
 * full size and this sits beside it: muted machine voice, never as large. The
 * approximation mark is decorative to a screen reader, so the same fact is spelled
 * out in words. The pinned month is always named, because a rate with no date is a
 * guess; a spot rate names the day it was taken instead.
 *
 * Renders nothing when there is no conversion (the same currency on both sides).
 */

import type { Conversion } from "../../core/types.ts";
import { formatDayMonth, formatMoney, pinMonthName } from "../lib/fmt.ts";

export function hasFx(c: Conversion | null | undefined): c is Conversion {
  return c !== null && c !== undefined && c.fx !== null && c.from.currency !== c.to.currency;
}

interface FxEquivalentProps {
  readonly conversion: Conversion | null | undefined;
  readonly className?: string;
}

export function FxEquivalent({ conversion, className }: FxEquivalentProps): JSX.Element | null {
  if (!hasFx(conversion)) return null;
  const fx = conversion.fx;
  if (fx === null) return null;

  const amount = formatMoney(conversion.to);
  const pinned = fx.source === "pinned_monthly" && fx.pinMonth !== null;
  const visible = pinned
    ? `≈ ${amount} · ${pinMonthName(fx.pinMonth ?? "")} pinned rate`
    : `≈ ${amount} · spot rate ${formatDayMonth(fx.asOf)}`;
  const spoken = pinned
    ? `approximately ${amount} at the ${pinMonthName(fx.pinMonth ?? "", true)} pinned rate`
    : `approximately ${amount} at the spot rate of ${formatDayMonth(fx.asOf)}`;

  return (
    <span className={`fx${className === undefined ? "" : ` ${className}`}`}>
      <span aria-hidden="true">{visible}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
