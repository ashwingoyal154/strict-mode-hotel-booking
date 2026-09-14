/**
 * Admin CSV export (§2.9 reporting, A18 auditor export).
 *
 * Every column is read off the booking's frozen snapshot, never off live supply.
 * Money is exported in integer minor units plus the currency, deliberately
 * unformatted. The column list is frozen in API_CONTRACT.md; Slice 2 appends.
 */

import type { ApprovalRequest, Booking, Invoice } from "../core/types.ts";

export const BOOKINGS_CSV_COLUMNS = [
  "confirmation_code",
  "created_at",
  "traveller_email",
  "property",
  "city",
  "check_in",
  "check_out",
  "nights",
  "commute_minutes",
  "commute_mode",
  "all_in_minor",
  "currency",
  "per_night_minor",
  "cap_per_night_minor",
  "policy_state",
  "policy_reason",
  "policy_version",
  "cost_centre",
  "state",
  "card_last4",
  "supplier_minor",
  "supplier_currency",
  "settlement_minor",
  "settlement_currency",
  "fx_rate_micros",
  "fx_pin_month",
  "approval_state",
  "approval_outcome",
  "invoice_number",
] as const;

/** RFC 4180 quoting: only when needed, doubling embedded quotes. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export function bookingsCsv(
  bookings: readonly Booking[],
  emailFor: (travellerId: string) => string,
  extras: {
    approvalFor?: (approvalId: string) => ApprovalRequest | undefined;
    invoiceFor?: (bookingId: string) => Invoice | undefined;
  } = {},
): string {
  const lines: string[] = [csvRow(BOOKINGS_CSV_COLUMNS)];
  for (const b of bookings) {
    // Slice 1 records have no amounts; fall back to the rate so old rows still export.
    const supplier = b.amounts?.supplier ?? b.offer.rate.allInTotal;
    const settlement = b.amounts?.settlement;
    const approval = b.approvalId === null || b.approvalId === undefined ? undefined : extras.approvalFor?.(b.approvalId);
    const invoice = extras.invoiceFor?.(b.id);
    lines.push(
      csvRow([
        b.confirmationCode,
        b.createdAt,
        emailFor(b.travellerId),
        b.offer.property.name,
        b.offer.property.city,
        b.offer.rate.checkIn,
        b.offer.rate.checkOut,
        b.offer.rate.nights,
        b.commute.minutes,
        b.commute.mode,
        b.offer.rate.allInTotal.minor,
        b.offer.rate.allInTotal.currency,
        b.offer.rate.perNight.minor,
        b.verdict.capPerNight === null ? null : b.verdict.capPerNight.minor,
        b.verdict.state,
        b.verdict.reason,
        b.verdict.policyVersion,
        b.costCentre,
        b.state,
        b.card === null ? null : b.card.last4,
        supplier.minor,
        supplier.currency,
        settlement?.to.minor ?? supplier.minor,
        settlement?.to.currency ?? supplier.currency,
        settlement?.fx?.rateMicros ?? null,
        settlement?.fx?.pinMonth ?? null,
        approval?.state ?? null,
        approval?.outcome ?? null,
        invoice?.number ?? null,
      ]),
    );
  }
  return `${lines.join("\n")}\n`;
}
