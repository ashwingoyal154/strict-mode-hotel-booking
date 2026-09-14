/**
 * The hotel-facing authorisation letter for a single-use virtual card (§3.2:
 * every booking ships one, because some front desks decline virtual cards).
 * It carries the card's last four digits and nothing more — there is no card
 * number anywhere in this system to print (A13).
 */

import { formatDateRange } from "../core/format.ts";
import { formatMoney, money } from "../core/money.ts";
import type { Booking, IssuedCard, LegalEntity, Traveller } from "../core/types.ts";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function authorisationLetterHtml(args: {
  booking: Booking;
  card: IssuedCard;
  traveller: Traveller | null;
  entity: LegalEntity;
  issuedAt: Date;
}): string {
  const { booking, card, traveller, entity } = args;
  const property = booking.offer.property;
  const rate = booking.offer.rate;
  const authorised = card.authorisedTotal;
  const buffer = money(card.incidentalsBufferMinor, authorised.currency);
  const guest = traveller?.name ?? "The booked guest";

  const rows: Array<[string, string]> = [
    ["Guest", guest],
    ["Hotel", `${property.name}, ${property.addressLine}, ${property.city}`],
    ["Stay", `${formatDateRange(rate.checkIn, rate.checkOut)} (${rate.checkIn} to ${rate.checkOut}, ${rate.nights} night${rate.nights === 1 ? "" : "s"})`],
    ["Confirmation", `${booking.confirmationCode}${booking.supplierBookingRef === null ? "" : ` · supplier ref ${booking.supplierBookingRef}`}`],
    ["Card", `${card.brand} virtual card ending ${card.last4}, valid ${card.validFrom} to ${card.validUntil}`],
    ["Authorised for the room", formatMoney(authorised, { decimals: true })],
    ["Incidentals buffer", formatMoney(buffer, { decimals: true })],
    ["Billed to", `${entity.legalName}${entity.gstin === null ? "" : ` · GSTIN ${entity.gstin}`}`],
    ["Billing address", entity.address],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Card authorisation · ${esc(booking.confirmationCode)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { text-align: left; vertical-align: top; padding: .5rem 0; border-bottom: 1px solid #ddd; }
  th { width: 34%; font-weight: 600; }
  .notice { font-weight: 700; border: 2px solid #111; padding: .75rem; }
</style>
</head>
<body>
<h1>Corporate card authorisation</h1>
<p>To the front desk of ${esc(property.name)}:</p>
<p>${esc(entity.legalName)} has paid for this stay with a single-use virtual card. Please charge the room to this card at check-out.</p>
<table>
${rows.map(([k, v]) => `  <tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("\n")}
</table>
<p class="notice">Please do not charge the guest. Do not ask the guest for a personal card or deposit. Charges above the authorised amount plus the incidentals buffer will be declined.</p>
<p>If the card is declined, call the number on your booking confirmation and quote ${esc(booking.confirmationCode)}.</p>
<p>Issued ${esc(args.issuedAt.toISOString().slice(0, 10))}.</p>
</body>
</html>
`;
}
