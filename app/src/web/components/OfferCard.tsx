/**
 * OfferCard — the approved field list, and nothing else.
 *
 *  1 commute badge        data-field="commute"
 *  2 rank + rank reason   data-field="rank"
 *  3 property name        data-field="name"
 *  4 address line         data-field="address"
 *  5 all-in total         data-field="total"   + per-night line data-field="per-night"
 *  6 verdict chip         data-field="verdict" (the chip plus its verbatim reason)
 *  7 Work-ready chip      data-field="work-ready"   only when true
 *  8 free-cancel chip     data-field="free-cancel"  only when refundable
 *  9 48px thumbnail       data-field="thumb"        only when one exists
 *
 * No star rating, no review score, no "popular", no urgency, no promotional
 * badge, no carousel, no crossed-out price, no supplier logo. No other element in
 * this file carries a data-field attribute.
 *
 * The verdict reason is rendered verbatim from `verdict.reason` — it is authored
 * server-side as the arithmetic, and it lives inside the verdict field because
 * "why" belongs to the verdict, not beside it.
 */

import { Link } from "react-router-dom";
import type { RankedOffer } from "../../core/types.ts";
import { describeCommute, formatDayMonth, formatMoney, perNightLine } from "../lib/fmt.ts";
import { VerdictChip } from "./VerdictChip.tsx";

interface OfferCardProps {
  readonly ranked: RankedOffer;
  /** Present when this card is the one tap to Confirm. Absent for blocked offers. */
  readonly href?: string;
  /** Marks a result that has just arrived, so it settles instead of popping. */
  readonly settling?: boolean;
}

export function OfferCard({ ranked, href, settling = false }: OfferCardProps): JSX.Element {
  const { offer, commute, verdict, rank, rankReason } = ranked;
  const { property, rate } = offer;

  const className = `offer${settling ? " offer--settling" : ""}`;

  const body = (
    <>
      <div className="offer__head">
        {property.thumbnailUrl !== null ? (
          <img
            data-field="thumb"
            className="offer__thumb"
            src={property.thumbnailUrl}
            alt=""
            loading="lazy"
          />
        ) : null}
        <div className="offer__headtext">
          <span data-field="commute" className="offer__commute">
            {describeCommute(commute)}
          </span>
          {rank > 0 && rankReason.length > 0 ? (
            <span data-field="rank" className="offer__rank">
              #{rank} &middot; {rankReason}
            </span>
          ) : null}
          <h3 data-field="name" className="offer__name">
            {property.name}
          </h3>
          <p data-field="address" className="offer__addr">
            {property.addressLine}
          </p>
        </div>
      </div>

      <div className="offer__money">
        <span data-field="total" className="offer__total">
          {formatMoney(rate.allInTotal)}
        </span>
        <span data-field="per-night" className="offer__pn">
          {perNightLine(rate)}
        </span>
      </div>

      <div data-field="verdict" className="offer__verdict">
        <VerdictChip verdict={verdict} />
        <span className="offer__reason">{verdict.reason}</span>
      </div>

      {property.workReady || rate.refundableUntil !== null ? (
        <div className="offer__chips">
          {property.workReady ? (
            <span data-field="work-ready" className="chip">
              Work-ready
            </span>
          ) : null}
          {rate.refundableUntil !== null ? (
            <span data-field="free-cancel" className="chip">
              Free until {formatDayMonth(rate.refundableUntil)}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (href === undefined) {
    return (
      <div data-testid="offer-card" className={className}>
        {body}
      </div>
    );
  }

  return (
    <Link data-testid="offer-card" className={className} to={href}>
      {body}
    </Link>
  );
}
