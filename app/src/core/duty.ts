/**
 * Duty of care: "who is where tonight" (§2.9).
 *
 * This view exists for the worst night of the year, so it errs toward including
 * people. A booking whose traveller record is missing is still listed — an
 * unnamed person in a city under advisory is a call to make, not a row to drop.
 */

import type { Booking, InMarketTraveller, IsoDate, Policy, Traveller } from "./types.ts";
import { advisoryFor } from "./policy.ts";

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Travellers in market on `date`: bookings `confirmed` or `pending_approval` with
 * checkIn ≤ date < checkOut, each with any advisory, sorted by country, city, name.
 */
export function travellersInMarket(args: {
  date: IsoDate;
  bookings: readonly Booking[];
  travellers: readonly Traveller[];
  policy: Policy;
}): InMarketTraveller[] {
  const { date, bookings, travellers, policy } = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`Expected an ISO date (YYYY-MM-DD), received "${date}"`);
  }
  const byId = new Map<string, Traveller>();
  for (const t of travellers) byId.set(t.id, t);

  const rows: InMarketTraveller[] = [];
  for (const b of bookings) {
    // A pending request is included: the traveller is going whether or not the
    // manager has answered, and duty of care cannot wait for the approval.
    if (b.state !== "confirmed" && b.state !== "pending_approval") continue;
    const { property, rate } = b.offer;
    // ISO dates compare correctly as strings; checkout night is not a night in market.
    if (!(rate.checkIn <= date && date < rate.checkOut)) continue;

    const traveller = byId.get(b.travellerId);
    rows.push({
      travellerId: b.travellerId,
      name: traveller?.name ?? "Unknown traveller",
      email: traveller?.email ?? "",
      bookingId: b.id,
      confirmationCode: b.confirmationCode,
      state: b.state,
      propertyName: property.name,
      propertyPhone: property.phone,
      addressLine: property.addressLine,
      city: property.city,
      countryCode: property.countryCode,
      checkIn: rate.checkIn,
      checkOut: rate.checkOut,
      advisory: advisoryFor(policy, property),
    });
  }

  return rows.sort(
    (a, b) =>
      compareText(a.countryCode, b.countryCode) ||
      compareText(a.city, b.city) ||
      compareText(a.name, b.name) ||
      compareText(a.bookingId, b.bookingId),
  );
}

/** Head-count and advisory-flagged count per country, ordered by country code like the rows beneath it. */
export function summariseByCountry(
  rows: readonly InMarketTraveller[],
): Array<{ countryCode: string; count: number; advisories: number }> {
  const byCountry = new Map<string, { countryCode: string; count: number; advisories: number }>();
  for (const row of rows) {
    const entry = byCountry.get(row.countryCode) ?? { countryCode: row.countryCode, count: 0, advisories: 0 };
    entry.count += 1;
    if (row.advisory !== null) entry.advisories += 1;
    byCountry.set(row.countryCode, entry);
  }
  return [...byCountry.values()].sort((a, b) => compareText(a.countryCode, b.countryCode));
}
