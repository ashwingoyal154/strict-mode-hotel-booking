/**
 * The tick. Vercel Hobby cron fires once a day and an approval SLA is measured in
 * minutes, so the same tick also runs opportunistically inside requests (see
 * index.ts). Everything here is idempotent: a second run over the same state
 * changes nothing.
 *
 *  1. Materialise SLA escalations and send their notifications (exactly once —
 *     approvals.ts ties each notification to the CAS write that recorded it).
 *  2. Settle confirmed stays whose checkout has passed, in the hotel's time zone.
 *  3. Issue GST invoices for settled stays (A10: after checkout).
 *  4. Purge search history older than 30 days (§3.2).
 */

import { buildInvoice, financialYearOf, invoiceNumber } from "../core/gst.ts";
import { newId } from "../core/ids.ts";
import { searchCutoff } from "../core/retention.ts";
import type { Booking, Invoice } from "../core/types.ts";
import type { Store } from "../store/Store.ts";
import { refreshApproval } from "./approvals.ts";
import { DEFAULT_ENTITY_ID } from "./auth.ts";
import type { AppDeps } from "./deps.ts";
import { checkoutInstant, errorMessage } from "./time.ts";

/** One legal entity per tenant in Slice 2. */
export const TICK_ENTITY_IDS: readonly string[] = [DEFAULT_ENTITY_ID];

/** An invoice issuer that died mid-issue releases its claim after this long. */
const STALE_INVOICE_CLAIM_MS = 5 * 60_000;

export interface TickResult {
  readonly escalated: number;
  readonly settled: number;
  readonly invoiced: number;
  readonly purgedSearches: number;
}

function logFailure(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`tick: ${what} failed: ${errorMessage(err)}`);
}

export async function tick(deps: AppDeps, now: Date): Promise<TickResult> {
  const at = { store: deps.store, notifiers: deps.notifiers, publicBaseUrl: deps.publicBaseUrl, now: () => now };
  let escalated = 0;
  let settled = 0;
  let invoiced = 0;

  for (const entityId of TICK_ENTITY_IDS) {
    const pending = await deps.store.listApprovals(entityId, { state: "pending" });
    for (const approval of pending) {
      try {
        escalated += (await refreshApproval(at, approval)).escalated.length;
      } catch (err) {
        logFailure(`escalating ${approval.id}`, err);
      }
    }

    const bookings = await deps.store.listBookingsForEntity(entityId);
    for (const b of bookings) {
      if (b.state !== "confirmed") continue;
      if (checkoutInstant(b.offer.rate.checkOut, b.offer.property.timeZone).getTime() > now.getTime()) continue;
      const flag = { changed: false };
      try {
        await deps.store.mutateBooking(b.id, (cur) => {
          flag.changed = cur.state === "confirmed";
          return flag.changed ? { ...cur, state: "settled", settledAt: now.toISOString() } : cur;
        });
        if (flag.changed) settled += 1;
      } catch (err) {
        logFailure(`settling ${b.id}`, err);
      }
    }

    const afterSettling = await deps.store.listBookingsForEntity(entityId);
    for (const b of afterSettling) {
      if (b.state !== "settled" || b.invoiceId !== null) continue;
      try {
        if ((await issueInvoiceFor(deps, b, now)) !== null) invoiced += 1;
      } catch (err) {
        logFailure(`invoicing ${b.id}`, err);
      }
    }
  }

  let purgedSearches = 0;
  try {
    purgedSearches = await deps.store.purgeSearchRecordsBefore(searchCutoff(now));
  } catch (err) {
    logFailure("purging searches", err);
  }

  return { escalated, settled, invoiced, purgedSearches };
}

async function linkInvoice(store: Store, bookingId: string, invoiceId: string): Promise<void> {
  await store.mutateBooking(bookingId, (cur) => (cur.invoiceId === null ? { ...cur, invoiceId } : cur));
}

/**
 * Issues the invoice for one settled booking. Returns the invoice when this call
 * created it, null when one already existed or another instance is issuing it.
 *
 * GST rule 46 wants consecutive numbers, so a sequence number must never be burnt
 * by two instances racing to invoice the same stay. The booking is claimed first
 * with an atomic idempotency-key reservation; only the claimant draws a number.
 */
export async function issueInvoiceFor(
  deps: { store: Store },
  booking: Booking,
  now: Date,
): Promise<Invoice | null> {
  const store = deps.store;
  const existing = await store.getInvoiceForBooking(booking.id);
  if (existing !== null) {
    if (booking.invoiceId === null) await linkInvoice(store, booking.id, existing.id);
    return null;
  }
  const entity = await store.getEntity(booking.entityId);
  if (entity === null) return null;

  const claimKey = `invoice:${booking.id}`;
  const claim = { key: claimKey, travellerId: "system", requestHash: "invoice", createdAt: now.toISOString() };
  let reservation = await store.reserveIdempotencyKey(claim);
  if (!reservation.reserved) {
    const held = reservation.existing;
    if (held.state === "completed") return null;
    if (now.getTime() - Date.parse(held.createdAt) <= STALE_INVOICE_CLAIM_MS) return null;
    await store.releaseIdempotencyKey(claimKey);
    reservation = await store.reserveIdempotencyKey(claim);
    if (!reservation.reserved) return null;
  }

  try {
    const issuedAt = now.toISOString();
    const financialYear = financialYearOf(issuedAt);
    const sequence = await store.nextInvoiceSequence(entity.id, financialYear);
    const invoice = buildInvoice({
      id: newId("inv"),
      booking,
      entity,
      number: invoiceNumber(entity.invoiceSeriesPrefix, financialYear, sequence),
      financialYear,
      issuedAt,
    });
    const created = await store.createInvoice(invoice);
    const final = created ? invoice : await store.getInvoiceForBooking(booking.id);
    if (final !== null) await linkInvoice(store, booking.id, final.id);
    await store.completeIdempotencyKey(claimKey, booking.id);
    return created ? invoice : null;
  } catch (err) {
    await store.releaseIdempotencyKey(claimKey).catch(() => undefined);
    throw err;
  }
}
