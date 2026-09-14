/**
 * Per-traveller export and erasure (§3.2, A20).
 *
 * Erasure strips the person out and keeps the money in: the traveller is
 * pseudonymised, meeting locations are scrubbed from bookings, and search history
 * and notifications are deleted. Bookings and invoices are retained because GST
 * record-keeping outranks erasure. Bookings are scrubbed *before* the traveller is
 * marked erased, so a crash part-way leaves a retry that can still finish the job.
 */

import { eraseTraveller, pseudonymFor, scrubBookingForErasure } from "../core/retention.ts";
import type { DataExport, ErasureReceipt, Invoice, Traveller } from "../core/types.ts";
import type { Store } from "../store/Store.ts";
import { searchRecordIdFor } from "./search.ts";

export const RETENTION_BASIS =
  "Bookings and tax invoices are kept for 7 years under Indian GST and income-tax record-keeping rules, with personal details removed.";

const EXPORT_NOTIFICATION_LIMIT = 10_000;

export async function buildDataExport(store: Store, traveller: Traveller, now: Date): Promise<DataExport> {
  const [bookings, allApprovals, notifications, searches, cardEvents] = await Promise.all([
    store.listBookingsForTraveller(traveller.id),
    store.listApprovals(traveller.entityId),
    store.listNotificationsFor(traveller.id, EXPORT_NOTIFICATION_LIMIT),
    store.listSearchRecordsFor(traveller.id),
    store.listCardEvents(traveller.entityId),
  ]);
  const bookingIds = new Set(bookings.map((b) => b.id));
  const invoices = (await Promise.all(bookings.map((b) => store.getInvoiceForBooking(b.id)))).filter(
    (i): i is Invoice => i !== null,
  );
  // Booking flows run under the booking id as correlation id and search fan-outs
  // under the search record id, so these are exactly the traveller's supplier calls.
  const correlationIds = [...bookingIds, ...searches.map((s) => s.id)];
  const sourceLog = correlationIds.length === 0 ? [] : await store.listSourceLogByCorrelation(correlationIds);

  return {
    exportedAt: now.toISOString(),
    traveller,
    bookings,
    approvals: allApprovals.filter((a) => a.travellerId === traveller.id || a.chain.includes(traveller.id)),
    invoices,
    notifications,
    searches,
    cardEvents: cardEvents.filter((e) => bookingIds.has(e.bookingId)),
    sourceLog,
  };
}

export async function eraseTravellerData(store: Store, traveller: Traveller, now: Date): Promise<ErasureReceipt> {
  const bookings = await store.listBookingsForTraveller(traveller.id);
  let invoices = 0;
  for (const b of bookings) {
    await store.mutateBooking(b.id, (cur) => scrubBookingForErasure(cur));
    if ((await store.getInvoiceForBooking(b.id)) !== null) invoices += 1;
  }
  const searches = await store.deleteSearchRecordsFor(traveller.id);
  const notifications = await store.deleteNotificationsFor(traveller.id);
  const erased = await store.mutateTraveller(traveller.id, (cur) => eraseTraveller(cur, now));

  return {
    travellerId: traveller.id,
    erasedAt: erased.erasedAt ?? now.toISOString(),
    pseudonym: pseudonymFor(traveller.id),
    retained: { bookings: bookings.length, invoices, basis: RETENTION_BASIS },
    deleted: { searches, notifications },
  };
}

/** Re-exported for tests that correlate exports with searches. */
export { searchRecordIdFor };
