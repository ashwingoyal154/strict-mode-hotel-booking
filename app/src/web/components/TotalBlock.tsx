/**
 * TotalBlock — the largest type on Confirm, and the product's only elevation step.
 *
 * The amount is the Money the API sent, rendered. Nothing here adds, sums or
 * re-derives: the component rows are the rate's own components in base → tax → fee
 * order, which the server guarantees sum exactly to `allInTotal`.
 *
 * Abroad, the supplier currency is the number the hotel charges, so it leads at
 * full size and the converted figure sits beside it, muted and smaller — a
 * converted figure is never typeset as large as a real one.
 *
 * Trip restates the same block with `flat`, without the elevation, so the number a
 * traveller sees after booking is typeset as the same number they accepted.
 */

import type { Conversion, Rate } from "../../core/types.ts";
import { formatMoney, perNightLine, rateBreakdown } from "../lib/fmt.ts";
import { FxEquivalent } from "./FxEquivalent.tsx";

export const WHOLE_NUMBER_SENTENCE = "This is the whole number. Nothing is added at the hotel.";

interface TotalBlockProps {
  readonly rate: Rate;
  readonly label?: string;
  /** Drops the elevation. Confirm is the only screen that keeps it. */
  readonly flat?: boolean;
  /** The all-in total in the display currency, when it differs. */
  readonly display?: Conversion | null;
}

export function TotalBlock({
  rate,
  label = "All-in total",
  flat = false,
  display = null,
}: TotalBlockProps): JSX.Element {
  const { rows, total } = rateBreakdown(rate);

  return (
    <section className={`total${flat ? " total--flat" : ""}`} aria-label={label}>
      <div className="total__headline">
        <span className="label">{label}</span>
        <span className="total__amount-line">
          <span className="total__amount">{formatMoney(total)}</span>
          <FxEquivalent conversion={display} className="total__fx" />
        </span>
        <span className="total__sub">{perNightLine(rate)}</span>
      </div>

      <div className="total__rows">
        {rows.map((row, i) => (
          <div className="total__row" key={`${row.kind}-${row.label}-${i}`}>
            <span className="total__row-label">{row.label}</span>
            <span className="total__row-amount">{formatMoney(row.amount, { decimals: true })}</span>
          </div>
        ))}
      </div>

      <p className="total__sentence">{WHOLE_NUMBER_SENTENCE}</p>
    </section>
  );
}
