/**
 * Admin CSV export (§2.9 reporting, A18 auditor export).
 *
 * Every column is read off the booking's frozen snapshot, never off live supply:
 * an export run a year from now must reproduce what was actually bought, at the
 * price and policy verdict that actually applied.
 *
 * The column list is frozen in API_CONTRACT.md. Money is exported in integer
 * minor units plus the currency, deliberately unformatted — a spreadsheet is a
 * machine reading, and `₹34,800` is not a number.
 */

import type { Booking } from "../core/types.ts";

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
] as const;

/** RFC 4180 quoting: only when needed, doubling embedded quotes. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvRow(cells: readonly (string | number | null)[]): string {
  return cells.map(csvCell).join(",");
}

export function bookingsCsv(
  bookings: readonly Booking[],
  emailFor: (travellerId: string) => string,
): string {
  const lines: string[] = [csvRow(BOOKINGS_CSV_COLUMNS)];
  for (const b of bookings) {
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
      ]),
    );
  }
  // Trailing newline: `wc -l` and most importers expect a terminated last record.
  return `${lines.join("\n")}\n`;
}
