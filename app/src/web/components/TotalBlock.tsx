/**
 * TotalBlock — the largest type on Confirm, and the product's only elevation step.
 *
 * The amount is the Money the API sent, rendered. Nothing here adds, sums or
 * re-derives: the component rows are the rate's own components in base → tax → fee
 * order, which the server guarantees sum exactly to `allInTotal`.
 *
 * Trip restates the same block with `flat`, without the elevation, so the number a
 * traveller sees after booking is typeset as the same number they accepted.
 */

import type { Rate } from "../../core/types.ts";
import { formatMoney, perNightLine, rateBreakdown } from "../lib/fmt.ts";

export const WHOLE_NUMBER_SENTENCE = "This is the whole number. Nothing is added at the hotel.";

interface TotalBlockProps {
  readonly rate: Rate;
  readonly label?: string;
  /** Drops the elevation. Confirm is the only screen that keeps it. */
  readonly flat?: boolean;
}

export function TotalBlock({ rate, label = "All-in total", flat = false }: TotalBlockProps): JSX.Element {
  const { rows, total } = rateBreakdown(rate);

  return (
    <section className={`total${flat ? " total--flat" : ""}`} aria-label={label}>
      <div className="total__headline">
        <span className="label">{label}</span>
        <span className="total__amount">{formatMoney(total)}</span>
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
