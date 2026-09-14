/**
 * Data retention and erasure (§3.2, A20).
 *
 * Erasure and tax law pull in opposite directions: GDPR/DPDP say forget the
 * person, GST says keep the invoice for years. The resolution is to strip the
 * person out of the record and keep the money in it — a pseudonym that is stable
 * (the same traveller always erases to the same name, so repeated requests are
 * idempotent) but carries nothing that identifies them.
 */

import type { Booking, IsoDateTime, Traveller } from "./types.ts";
import { stableHash } from "./ids.ts";

/** Retention periods from §3.2: bookings 7 years (tax), traveller location 90 days, searches 30 days. */
export const RETENTION: { readonly bookingsYears: 7; readonly locationDays: 90; readonly searchDays: 30 } = {
  bookingsYears: 7,
  locationDays: 90,
  searchDays: 30,
};

const MS_PER_DAY = 86_400_000;

/** A stable, non-identifying pseudonym: "erased-" plus the first 10 hex characters of the id's hash. */
export function pseudonymFor(travellerId: string): string {
  return `erased-${stableHash(travellerId).slice(0, 10)}`;
}

/**
 * The traveller with name and email pseudonymised and `erasedAt` set. Already
 * erased travellers are returned unchanged, so the original erasure time stands.
 */
export function eraseTraveller(t: Traveller, now: Date): Traveller {
  if (t.erasedAt !== null) return t;
  return {
    ...t,
    name: "Erased traveller",
    email: `${pseudonymFor(t.id)}@erased.invalid`,
    erasedAt: now.toISOString(),
  };
}

/**
 * A booking with its meeting location removed — the anchor is where a named
 * person was going to be, which is personal data. Money, tax and property facts
 * stay, because the invoice they support must outlive the erasure.
 */
export function scrubBookingForErasure(b: Booking): Booking {
  return {
    ...b,
    anchor: {
      label: "(erased)",
      geo: { lat: 0, lng: 0 },
      city: b.anchor.city,
      countryCode: b.anchor.countryCode,
    },
  };
}

/** The instant before which search history is purged: `now` minus 30 days. */
export function searchCutoff(now: Date): IsoDateTime {
  return new Date(now.getTime() - RETENTION.searchDays * MS_PER_DAY).toISOString();
}
