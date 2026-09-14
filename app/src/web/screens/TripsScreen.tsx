/**
 * Trips — the traveller's own bookings, newest first.
 *
 * These are deliberately not offer cards: nothing here is being chosen, so none of
 * the card's fields apply and none of its markup is reused.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Booking } from "../../core/types.ts";
import { isApiError, listBookings, messageOf } from "../lib/api.ts";
import { formatDateRange, formatMoney, nightsBetween, plural, stateWords } from "../lib/fmt.ts";
import { Notice } from "../components/Notice.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";

type Phase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly bookings: readonly Booking[] }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

export function TripsScreen(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  useEffect(() => {
    let live = true;
    void listBookings()
      .then((res) => {
        if (live) setPhase({ k: "ready", bookings: res.bookings });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPhase({
          k: "fault",
          code: isApiError(err) ? err.code : "unexpected_error",
          message: messageOf(err),
        });
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="screen">
      <div className="screen__head">
        <h1 className="h1">Your trips</h1>
        <p className="prose prose--quiet">
          Everything your company has paid for on your behalf.
        </p>
      </div>

      {phase.k === "loading" ? <p className="mono mono--muted">loading&hellip;</p> : null}

      {phase.k === "fault" ? (
        <Notice tone="blocked" code={phase.code} title="We could not load your trips">
          <p className="prose">{phase.message}</p>
        </Notice>
      ) : null}

      {phase.k === "ready" && phase.bookings.length === 0 ? (
        <div className="empty">
          <span className="label">0 trips</span>
          <p className="prose">You have not booked anything yet.</p>
          <Link to="/" className="btn">
            Find somewhere near a meeting
          </Link>
        </div>
      ) : null}

      {phase.k === "ready" && phase.bookings.length > 0 ? (
        <ul className="trips__list">
          {phase.bookings.map((b) => {
            const { property, rate } = b.offer;
            return (
              <li key={b.id}>
                <Link className="trip-row" to={`/trip/${encodeURIComponent(b.id)}`}>
                  <div className="trip-row__top">
                    <span className="trip-row__code">{b.confirmationCode}</span>
                    <span className="chip chip--state">{stateWords(b.state)}</span>
                    <VerdictChip verdict={b.verdict} />
                  </div>
                  <h2 className="trip-row__name">{property.name}</h2>
                  <div className="trip-row__meta">
                    <span>{property.city}</span>
                    <span>{formatDateRange(rate.checkIn, rate.checkOut)}</span>
                    <span>{plural(nightsBetween(rate.checkIn, rate.checkOut), "night")}</span>
                    <span className="trip-row__total">{formatMoney(rate.allInTotal)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
