/**
 * Trip — one object. The confirmation code, how to get there, who to call, the
 * frozen number, the frozen verdict, and what can still be done with it.
 *
 * Everything on this screen is read from the stored booking, never from live
 * supply: the offer, commute and verdict were frozen at request time so the number
 * here is byte-identical to the one that was accepted.
 *
 * Slice 2 states:
 *   · pending_approval — the SLA line (ticking at most once a minute), the hold
 *     line directly under the total in exactly one of its two honest forms, the
 *     traveller's justification, the escalation ladder, and Withdraw. The booking
 *     is re-read every 20 seconds while pending, so a decision arrives by itself.
 *   · decided — a designed outcome for confirmed, rate_lost, sold_out,
 *     card_declined, rejected (with the approver's note) and withdrawn.
 *   · confirmed — the invoice link (or when it will exist), the authorisation
 *     letter, "Card declined at the desk?", Modify, and the cancel window.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import type { Invoice, IsoDateTime } from "../../core/types.ts";
import {
  asCancellationDeadline,
  asInvoiceNotReady,
  authorisationLetterHref,
  cancelBooking,
  getBooking,
  getInvoice,
  isApiError,
  listNotifications,
  messageOf,
  withdrawBooking,
  type BookingRead,
} from "../lib/api.ts";
import {
  describeCommute,
  formatClock,
  formatDateRange,
  formatDeadline,
  formatStamp,
  mapsHref,
  nightsBetween,
  plural,
  stateWords,
  telHref,
} from "../lib/fmt.ts";
import { ApprovalOutcome } from "../components/ApprovalOutcome.tsx";
import { CancelWindow } from "../components/CancelWindow.tsx";
import { DecidedLine } from "../components/DecidedLine.tsx";
import { DeskDeclined } from "../components/DeskDeclined.tsx";
import { EscalationLadder } from "../components/EscalationLadder.tsx";
import { HoldLine } from "../components/HoldLine.tsx";
import { Notice } from "../components/Notice.tsx";
import { SlaLine } from "../components/SlaLine.tsx";
import { TotalBlock } from "../components/TotalBlock.tsx";
import { VerdictChip } from "../components/VerdictChip.tsx";

const POLL_MS = 20_000;

type Phase =
  | { readonly k: "loading" }
  | { readonly k: "ready"; readonly read: BookingRead }
  | { readonly k: "fault"; readonly code: string; readonly message: string };

type InvoiceStatus =
  | { readonly k: "none" }
  | { readonly k: "ready"; readonly number: string; readonly kind: Invoice["kind"] }
  | { readonly k: "later"; readonly availableAfter: IsoDateTime }
  | { readonly k: "unavailable"; readonly message: string };

interface Flash {
  readonly requested: boolean;
  readonly bookedWithoutApproval: boolean;
  readonly modifiedFrom: string | null;
}

function readFlash(state: unknown): Flash {
  const rec = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  const from = rec["modifiedFrom"];
  return {
    requested: rec["requested"] === true,
    bookedWithoutApproval: rec["bookedWithoutApproval"] === true,
    modifiedFrom: typeof from === "string" ? from : null,
  };
}

/** Cancellations that mean "this was never booked", which the outcome notice already explains. */
const NOT_BOOKED_REASONS = new Set(["withdrawn", "rate_lost", "sold_out", "card_declined"]);

export function TripScreen(): JSX.Element {
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const flash = readFlash(useLocation().state);

  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceStatus>({ k: "none" });
  const [rateLostSentence, setRateLostSentence] = useState<string | null>(null);

  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelFault, setCancelFault] = useState<{
    code: string;
    message: string;
    deadline: string | null;
  } | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawFault, setWithdrawFault] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    setPhase({ k: "loading" });
    void getBooking(bookingId)
      .then((res) => {
        if (!live) return;
        setPhase({ k: "ready", read: res });
        setCheckedAt(Date.now());
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

  const state = phase.k === "ready" ? phase.read.booking.state : null;
  const pending = state === "pending_approval";

  // While pending, re-read every 20 seconds so a decision arrives by itself.
  useEffect(() => {
    if (!pending) return undefined;
    let live = true;
    const id = window.setInterval(() => {
      void getBooking(bookingId)
        .then((res) => {
          if (!live) return;
          setPhase({ k: "ready", read: res });
          setCheckedAt(Date.now());
          setPollFailed(false);
        })
        .catch(() => {
          if (live) setPollFailed(true);
        });
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [pending, bookingId]);

  const outcome = phase.k === "ready" ? phase.read.approval?.outcome ?? null : null;

  // The "after" figure of a lost rate lives only in the server's notification.
  useEffect(() => {
    if (outcome !== "rate_lost") return undefined;
    let live = true;
    void listNotifications()
      .then((res) => {
        if (!live) return;
        const hit = res.notifications.find(
          (n) => n.kind === "approval_rate_lost" && n.bookingId === bookingId,
        );
        if (hit !== undefined && hit.body.trim().length > 0) setRateLostSentence(hit.body);
      })
      .catch(() => {
        /* the outcome still states the number it knows */
      });
    return () => {
      live = false;
    };
  }, [outcome, bookingId]);

  const inlineInvoice = phase.k === "ready" ? phase.read.invoice ?? null : null;
  const inlineNumber = inlineInvoice?.number ?? null;
  const inlineKind = inlineInvoice?.kind ?? null;

  useEffect(() => {
    if (state !== "confirmed" && state !== "settled") {
      setInvoice({ k: "none" });
      return undefined;
    }
    if (inlineNumber !== null && inlineKind !== null) {
      setInvoice({ k: "ready", number: inlineNumber, kind: inlineKind });
      return undefined;
    }
    let live = true;
    void getInvoice(bookingId)
      .then((res) => {
        if (live) setInvoice({ k: "ready", number: res.invoice.number, kind: res.invoice.kind });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && err.code === "invoice_not_ready") {
          const detail = asInvoiceNotReady(err.detail);
          if (detail !== null) {
            setInvoice({ k: "later", availableAfter: detail.availableAfter });
            return;
          }
        }
        setInvoice({ k: "unavailable", message: messageOf(err) });
      });
    return () => {
      live = false;
    };
  }, [bookingId, state, inlineNumber, inlineKind]);

  const runCancel = useCallback(async (): Promise<void> => {
    setCancelBusy(true);
    setCancelFault(null);
    try {
      const res = await cancelBooking(bookingId);
      setPhase((p) =>
        p.k === "ready"
          ? { k: "ready", read: { ...p.read, booking: res.booking } }
          : { k: "ready", read: { booking: res.booking } },
      );
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

  const runWithdraw = useCallback(async (): Promise<void> => {
    setWithdrawBusy(true);
    setWithdrawFault(null);
    try {
      const res = await withdrawBooking(bookingId);
      setPhase((p) => ({
        k: "ready",
        read: {
          booking: res.booking,
          approval: res.approval,
          invoice: p.k === "ready" ? p.read.invoice ?? null : null,
        },
      }));
    } catch (err) {
      if (isApiError(err) && err.code === "not_pending") {
        // Somebody decided first. Show what they decided rather than an error.
        try {
          const fresh = await getBooking(bookingId);
          setPhase({ k: "ready", read: fresh });
        } catch {
          /* keep the page as it was */
        }
      }
      setWithdrawFault({
        code: isApiError(err) ? err.code : "unexpected_error",
        message: messageOf(err),
      });
    } finally {
      setWithdrawBusy(false);
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

  const { booking } = phase.read;
  const approval = phase.read.approval ?? null;
  const { property, rate } = booking.offer;
  const nights = nightsBetween(rate.checkIn, rate.checkOut);
  const now = new Date();

  const neverBooked =
    booking.state === "rejected" ||
    (booking.state === "cancelled" &&
      booking.cancellationReason !== null &&
      NOT_BOOKED_REASONS.has(booking.cancellationReason));
  const confirmed = booking.state === "confirmed";
  const settled = booking.state === "settled";
  const decided = approval !== null && approval.state !== "pending";

  const searchAgain = {
    to: "/",
    state: {
      prefill: {
        anchorQuery: booking.anchor.label,
        checkIn: rate.checkIn,
        checkOut: rate.checkOut,
      },
    },
  };

  const totalLabel = pending
    ? "Requested total"
    : neverBooked
      ? "Requested total · not booked"
      : "Paid by your company";

  const paymentLine =
    booking.card !== null
      ? `${booking.card.brand} virtual card ··${booking.card.last4}`
      : pending
        ? "no card until it is approved"
        : neverBooked
          ? "no card was issued"
          : "central billing";

  return (
    <div className="trip">
      <div className="screen__head">
        <h1 className="h1">{property.name}</h1>
        <p className="confirm__addr">{property.addressLine}</p>
      </div>

      <div className="trip__code panel">
        <span className="label">{pending || neverBooked ? "Request" : "Confirmation"}</span>
        <span className="trip__code-value">{booking.confirmationCode}</span>
        <span className="mono mono--muted">
          {stateWords(booking.state)} &middot; {pending || neverBooked ? "requested" : "booked"}{" "}
          {formatStamp(booking.createdAt)}
        </span>
      </div>

      {flash.modifiedFrom !== null && confirmed ? (
        <Notice tone="in" code="modified" title="Changed">
          <p className="prose">
            This stay replaces {flash.modifiedFrom}. The new room was booked first, then the old
            one was cancelled.
          </p>
        </Notice>
      ) : null}

      {flash.bookedWithoutApproval && confirmed && approval === null ? (
        <Notice tone="in" code="201 · in policy" title="Booked without needing approval">
          <p className="prose">
            By the time you sent it, your policy allowed this rate, so it was booked straight
            away at the total you accepted. Nobody was asked.
          </p>
        </Notice>
      ) : null}

      {pending && approval !== null ? (
        <section className="pending" aria-labelledby="pending-title">
          <Notice tone="over" code="pending approval">
            <h2 className="h3" id="pending-title">
              {flash.requested ? "Sent for approval" : "Waiting for approval"}
            </h2>
            <p className="prose">
              Nothing is booked and no card is issued until {approval.sla.approverName} says
              yes. If they don&rsquo;t decide in time, it moves up the chain.
            </p>
          </Notice>
          <SlaLine approval={approval} />
        </section>
      ) : null}

      {decided && approval !== null ? (
        <ApprovalOutcome
          booking={booking}
          approval={approval}
          rateLostSentence={rateLostSentence}
          searchAgain={searchAgain}
        />
      ) : null}

      {booking.state === "modified" ? (
        <Notice tone="neutral" code="modified" title="This booking was changed">
          <p className="prose">
            It was replaced by a new booking and cancelled after that one was confirmed.
          </p>
          {booking.replacedBy !== null ? (
            <div className="notice__actions">
              <Link to={`/trip/${encodeURIComponent(booking.replacedBy)}`} className="btn">
                Open the new booking
              </Link>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {booking.state === "cancelled" && !neverBooked ? (
        <Notice tone="neutral" code="cancelled" title="This trip is cancelled">
          <p className="prose">
            Cancelled{" "}
            {booking.cancelledAt === null ? "" : `at ${formatStamp(booking.cancelledAt)}`}. The
            virtual card was voided with it, so there is nothing to pay and nothing to file.
          </p>
        </Notice>
      ) : null}

      {!neverBooked ? (
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
      ) : null}

      <div className="confirm__facts">
        <VerdictChip verdict={booking.verdict} />
        <span className="mono">{booking.verdict.reason}</span>
      </div>

      <div className="trip__money">
        <TotalBlock
          rate={rate}
          label={totalLabel}
          flat
          display={booking.amounts?.display ?? null}
        />
        {pending ? <HoldLine hold={booking.hold} /> : null}
      </div>

      {approval !== null && approval.justificationText.trim().length > 0 ? (
        <section className="justified" aria-label="Your justification">
          <span className="label">
            Your reason &middot; {approval.justificationCode.replace(/_/g, " ")}
          </span>
          <blockquote className="quote">
            <p>{approval.justificationText}</p>
          </blockquote>
        </section>
      ) : null}

      {approval !== null ? <EscalationLadder approval={approval} /> : null}

      {pending ? (
        <div className="trip__withdraw">
          <p className="mono mono--muted" aria-live="polite">
            {pollFailed
              ? "could not re-check · retrying every 20s"
              : `re-checks every 20s${checkedAt === null ? "" : ` · last ${formatClock(new Date(checkedAt).toISOString(), now)}`}`}
          </p>
          {withdrawFault !== null ? (
            <Notice tone="blocked" code={withdrawFault.code} title="That did not withdraw">
              <p className="prose">{withdrawFault.message}</p>
            </Notice>
          ) : null}
          <button
            type="button"
            className="btn-quiet-danger"
            disabled={withdrawBusy}
            onClick={() => void runWithdraw()}
          >
            {withdrawBusy ? "Withdrawing…" : "Withdraw this request"}
          </button>
          <p className="prose prose--quiet">
            Withdrawing releases any hold. Nothing was booked, so nothing is charged.
          </p>
        </div>
      ) : null}

      {withdrawFault !== null && !pending ? (
        <Notice tone="neutral" code={withdrawFault.code} title="It was decided before you withdrew">
          <p className="prose">{withdrawFault.message}</p>
        </Notice>
      ) : null}

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
        <DecidedLine label="Payment" value={paymentLine} />
        <DecidedLine label="Hotel" value={property.phone} />
        <DecidedLine
          label="Policy"
          value={`${booking.verdict.reasonCode} · version ${booking.verdict.policyVersion}`}
        />
      </div>

      {confirmed || settled ? (
        <section className="trip__docs" aria-labelledby="docs-title">
          <h2 className="h3" id="docs-title">
            Documents
          </h2>
          <div className="confirm__decided trip__docs-rows">
            <div className="decided">
              <span className="label decided__label">Invoice</span>
              {invoice.k === "ready" ? (
                <Link className="btn-text" to={`/trip/${encodeURIComponent(booking.id)}/invoice`}>
                  {invoice.kind === "gst_tax_invoice" ? "GST invoice" : "tax summary"} &middot;{" "}
                  {invoice.number}
                </Link>
              ) : invoice.k === "later" ? (
                <span className="decided__value">
                  available after checkout &middot; {formatDeadline(invoice.availableAfter)}
                </span>
              ) : invoice.k === "unavailable" ? (
                <span className="decided__value">{invoice.message}</span>
              ) : (
                <span className="decided__value">checking&hellip;</span>
              )}
            </div>
            {booking.card !== null ? (
              <div className="decided">
                <span className="label decided__label">For the hotel</span>
                <a
                  className="btn-text"
                  href={authorisationLetterHref(booking.id)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  authorisation letter &middot; card ··{booking.card.last4}
                </a>
              </div>
            ) : null}
          </div>
          {confirmed && booking.card !== null ? <DeskDeclined bookingId={booking.id} /> : null}
        </section>
      ) : null}

      {confirmed ? (
        <div className="trip__modify">
          <Link className="btn" to={`/trip/${encodeURIComponent(booking.id)}/modify`}>
            Modify this stay
          </Link>
        </div>
      ) : null}

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
            Your booking is untouched. Cancelling here only works inside the free window
            &mdash; anything else goes to the 24/7 desk.
          </p>
        </Notice>
      ) : null}

      {confirmed && booking.cancellationDeadline !== null ? (
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
