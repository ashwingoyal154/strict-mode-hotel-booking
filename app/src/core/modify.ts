/**
 * Modify = cancel + rebook, one flow, price delta up front (§2.7).
 *
 * The quote is a statement of what the change costs, in the traveller's terms.
 * Outside the free-cancellation window the honest number is not the delta between
 * two rates — it is the whole current stay, which is lost — so that message wins.
 */

import type { Booking, ModifyQuote, Offer, PolicyVerdict } from "./types.ts";
import { absMoney, formatMoney, money, subMoney } from "./money.ts";
import { isCancellableAt } from "./booking.ts";

function lostStayMessage(total: ModifyQuote["currentTotal"]): string {
  return `Your current booking can no longer be cancelled for free, so changing it would cost ${formatMoney(total)}`;
}

/** Whether a booking may be modified at `now`: it must be confirmed and inside its free-cancellation window. */
export function canModify(
  booking: Booking,
  now: Date,
): { ok: true } | { ok: false; code: "not_confirmed" | "outside_free_window"; message: string } {
  if (booking.state !== "confirmed") {
    return { ok: false, code: "not_confirmed", message: "Only a confirmed booking can be changed" };
  }
  if (!isCancellableAt(booking, now)) {
    return { ok: false, code: "outside_free_window", message: lostStayMessage(booking.offer.rate.allInTotal) };
  }
  return { ok: true };
}

/**
 * The cost of replacing a booking with `newOffer`: a signed delta when currencies
 * match, what cancelling the current stay costs, and one sentence saying so.
 */
export function quoteModify(args: {
  booking: Booking;
  newOffer: Offer;
  newVerdict: PolicyVerdict;
  searchId: string;
  now: Date;
}): ModifyQuote {
  const { booking, newOffer, newVerdict, searchId, now } = args;
  const currentTotal = booking.offer.rate.allInTotal;
  const newTotal = newOffer.rate.allInTotal;

  const delta = currentTotal.currency === newTotal.currency ? subMoney(newTotal, currentTotal) : null;
  const freeToCancel = isCancellableAt(booking, now);
  const cancellationCost = freeToCancel ? money(0, currentTotal.currency) : currentTotal;

  let message: string;
  if (!freeToCancel) message = lostStayMessage(currentTotal);
  else if (delta === null) {
    // Two currencies have no honest difference without a rate; show both totals instead.
    message = `${formatMoney(newTotal)} instead of ${formatMoney(currentTotal)} for your current booking`;
  } else if (delta.minor > 0) message = `${formatMoney(delta)} more than your current booking`;
  else if (delta.minor < 0) message = `${formatMoney(absMoney(delta))} less than your current booking`;
  else message = "Same total as your current booking";

  return {
    bookingId: booking.id,
    searchId,
    newOfferId: newOffer.rate.id,
    currentTotal,
    newTotal,
    delta,
    cancellationCost,
    verdict: newVerdict,
    message,
  };
}
