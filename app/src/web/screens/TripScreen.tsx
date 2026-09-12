/**
 * Trip — one object. The confirmation code, how to get there, who to call, the
 * frozen number, the frozen verdict, and the cancel window.
 *
 * Everything on this screen is read from the stored booking, never from live
 * supply: the offer, commute and verdict were frozen at confirmation so the number
 * here is byte-identical to the one that was accepted.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Booking } from "../../core/types.ts";
import {
  asCancellationDeadline,
  cancelBooking,
  getBooking,
  isApiError,
  messageOf,
} from "../lib/api.ts";
import {
  describeCommute,
  formatDateRange,
  formatDeadline,
  formatStamp,
  mapsHref,
  nightsBetween,
  plural,
  telHref,
} from "../lib/fmt.ts";
import { CancelWindow } from "../components/CancelWindow.tsx";
import { DecidedLine } from "../components/DecidedLine.tsx";
import { Notice } from "../components/Notice.tsx";
import { TotalBlock } from "../components/TotalBlock.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";

type Phase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly booking: Booking }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

export function TripScreen(): JSX.Element {
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelFault, setCancelFault] = useState<{
    code: string;
    message: string;
    deadline: string | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ k: "loading" });
    void getBooking(bookingId)
      .then((res) => {
        if (live) setPhase({ k: "ready", booking: res.booking });
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
  }, [bookingId]);

  const runCancel = useCallback(async (): Promise<void> => {
    setCancelBusy(true);
    setCancelFault(null);
    try {
      const res = await cancelBooking(bookingId);
      setPhase({ k: "ready", booking: res.booking });
    } catch (err) {
      setCancelFault({
        code: isApiError(err) ? err.code : "unexpected_error",
        message: messageOf(err),
        deadline: isApiError(err) ? asCancellationDeadline(err.detail) : null,
      });
    } finally {
      setCancelBusy(false);
    }
  }, [bookingId]);

  if (phase.k === "loading") {
    return (
      <div className="screen">
        <h1 className="h1">Your trip</h1>
        <p className="mono mono--muted">loading the booking record&hellip;</p>
      </div>
    );
  }

  if (phase.k === "fault") {
    return (
      <div className="screen">
        <h1 className="h1">Your trip</h1>
        <Notice tone="blocked" code={phase.code} title="We could not open that booking">
          <p className="prose">{phase.message}</p>
        </Notice>
        <Link to="/trips" className="btn">
          All your trips
        </Link>
      </div>
    );
  }

  const { booking } = phase;
  const { property, rate } = booking.offer;
  const nights = nightsBetween(rate.checkIn, rate.checkOut);
  const cancelled = booking.state === "cancelled";

  return (
    <div className="trip">
      <div className="screen__head">
        <h1 className="h1">{property.name}</h1>
        <p className="confirm__addr">{property.addressLine}</p>
      </div>

      <div className="trip__code panel">
        <span className="label">Confirmation</span>
        <span className="trip__code-value">{booking.confirmationCode}</span>
        <span className="mono mono--muted">
          {booking.state} &middot; booked {formatStamp(booking.createdAt)}
        </span>
      </div>

      {cancelled ? (
        <Notice tone="neutral" code="cancelled" title="This trip is cancelled">
          <p className="prose">
            Cancelled{" "}
            {booking.cancelledAt === null ? "" : `at ${formatStamp(booking.cancelledAt)}`}. The
            virtual card was voided with it, so there is nothing to pay and nothing to file.
          </p>
        </Notice>
      ) : null}

      <div className="trip__links">
        <a
          className="btn"
          href={mapsHref(property.geo.lat, property.geo.lng, property.name)}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in maps
        </a>
        <a className="btn" href={telHref(property.phone)}>
          Call the hotel
        </a>
      </div>

      <div className="confirm__facts">
        <VerdictChip verdict={booking.verdict} />
        <span className="mono">{booking.verdict.reason}</span>
      </div>

      <TotalBlock rate={rate} label="Paid by your company" flat />

      <div className="confirm__decided">
        <DecidedLine
          label="Dates"
          value={`${formatDateRange(rate.checkIn, rate.checkOut)} · ${plural(nights, "night")}`}
        />
        <DecidedLine
          label="Commute"
          value={`${describeCommute(booking.commute)} to ${booking.anchor.label}`}
        />
        <DecidedLine label="Cost centre" value={booking.costCentre} />
        <DecidedLine
          label="Payment"
          value={
            booking.card === null
              ? "central billing"
              : `${booking.card.brand} virtual card ··${booking.card.last4}`
          }
        />
        <DecidedLine label="Hotel" value={property.phone} />
        <DecidedLine
          label="Policy"
          value={`${booking.verdict.reasonCode} · version ${booking.verdict.policyVersion}`}
        />
      </div>

      {cancelFault !== null ? (
        <Notice
          tone="blocked"
          code={cancelFault.code}
          title={
            cancelFault.code === "outside_free_window"
              ? "The free window has closed"
              : "That cancellation did not go through"
          }
        >
          <p className="prose">{cancelFault.message}</p>
          {cancelFault.deadline !== null ? (
            <p className="mono">free until {formatDeadline(cancelFault.deadline)}, local time</p>
          ) : null}
          <p className="prose prose--quiet">
            Your booking is untouched. This slice only cancels inside the free window &mdash;
            anything else goes to the 24/7 desk.
          </p>
        </Notice>
      ) : null}

      {!cancelled && booking.cancellationDeadline !== null ? (
        <div className="panel">
          <CancelWindow
            deadline={booking.cancellationDeadline}
            onCancel={() => void runCancel()}
            busy={cancelBusy}
          />
        </div>
      ) : null}

      <Link to="/trips" className="btn-text">
        All your trips
      </Link>
    </div>
  );
}
