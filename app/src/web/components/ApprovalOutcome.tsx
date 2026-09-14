/**
 * ApprovalOutcome — what happened after somebody decided. An approval can win and
 * the booking still lose, so every outcome is a designed state with a way
 * forward, never an error screen:
 *
 *   confirmed      Approved by Meera Iyer at 3:05 pm · booked
 *   rate_lost      Approved — but the rate moved from ₹42,380 to ₹44,100. Nothing was booked.
 *   sold_out       Approved — but the hotel sold out first. Nothing was booked.
 *   card_declined  Approved — but the card was declined. Nothing was booked.
 *   rejected       Rejected by Meera Iyer at 3:05 pm, with their note quoted
 *   withdrawn      You withdrew it
 *
 * The "after" number of a lost rate is not on the booking or the approval — the
 * booking is frozen at request time by design. It is read from the server's own
 * `approval_rate_lost` notification for this booking, verbatim, and when that is
 * not available the line states the number it does know rather than guessing one.
 */

import { Link } from "react-router-dom";
import type { Booking } from "../../core/types.ts";
import type { ApprovalView } from "../lib/api.ts";
import { formatClock, formatMoney } from "../lib/fmt.ts";
import { Notice } from "./Notice.tsx";

interface ApprovalOutcomeProps {
  readonly booking: Booking;
  readonly approval: ApprovalView;
  /** The server-written rate_lost sentence, when a notification carries it. */
  readonly rateLostSentence: string | null;
  /** Where "search again" goes, with the anchor and dates carried over. */
  readonly searchAgain: { readonly to: string; readonly state: unknown };
}

function deciderName(approval: ApprovalView): string {
  if (approval.decidedBy === null) return "your approver";
  return approval.approvers.find((a) => a.id === approval.decidedBy)?.name ?? "your approver";
}

export function ApprovalOutcome({
  booking,
  approval,
  rateLostSentence,
  searchAgain,
}: ApprovalOutcomeProps): JSX.Element | null {
  const now = new Date();
  const at = approval.decidedAt === null ? "" : ` at ${formatClock(approval.decidedAt, now)}`;
  const who = deciderName(approval);
  const before = formatMoney(booking.amounts.supplier);

  const again = (
    <Link to={searchAgain.to} state={searchAgain.state} className="btn">
      Search these dates again
    </Link>
  );

  if (approval.state === "withdrawn") {
    return (
      <Notice tone="neutral" code="withdrawn" title="You withdrew this request">
        <p className="prose">
          Withdrawn{at}. Any hold was released, nothing was booked and no card was issued.
        </p>
        <div className="notice__actions">{again}</div>
      </Notice>
    );
  }

  if (approval.state === "rejected") {
    return (
      <Notice tone="blocked" code="rejected" title={`Rejected by ${who}`}>
        <p className="mono">
          rejected{at} &middot; nothing was booked &middot; no card was issued
        </p>
        {approval.decisionNote !== null && approval.decisionNote.trim().length > 0 ? (
          <blockquote className="quote">
            <p>{approval.decisionNote}</p>
            <footer className="mono mono--muted">{who}</footer>
          </blockquote>
        ) : null}
        <div className="notice__actions">{again}</div>
      </Notice>
    );
  }

  if (approval.state !== "approved") return null;

  switch (approval.outcome) {
    case "confirmed":
      return (
        <Notice tone="in" code="approved · confirmed" title={`Approved by ${who}`}>
          <p className="mono">
            approved{at} &middot; booked &middot; single-use card issued
          </p>
        </Notice>
      );
    case "rate_lost":
      return (
        <Notice tone="over" code="approved · rate_lost" title="Approved, but the rate moved">
          <p className="outcome__sentence">
            {rateLostSentence ?? `Approved — but the rate moved from ${before}. Nothing was booked.`}
          </p>
          <p className="prose prose--quiet">
            {who} said yes{at}, and the hotel no longer sells this stay at the price that was
            approved. We did not book it at a different price for you, and no card was issued.
          </p>
          <div className="notice__actions">{again}</div>
        </Notice>
      );
    case "sold_out":
      return (
        <Notice tone="over" code="approved · sold_out" title="Approved, but it sold out">
          <p className="outcome__sentence">
            Approved — but the hotel sold out before it could be booked at {before}. Nothing was
            booked.
          </p>
          <div className="notice__actions">{again}</div>
        </Notice>
      );
    case "card_declined":
      return (
        <Notice tone="over" code="approved · card_declined" title="Approved, but the card was declined">
          <p className="outcome__sentence">
            Approved — but the virtual card for {before} was declined, so nothing was booked.
          </p>
          <p className="prose prose--quiet">
            You have not been charged and there is nothing for you to pay.
          </p>
          <div className="notice__actions">{again}</div>
        </Notice>
      );
    default:
      return (
        <Notice tone="neutral" code="approved" title={`Approved by ${who}`}>
          <p className="mono">approved{at} &middot; booking in progress</p>
        </Notice>
      );
  }
}
