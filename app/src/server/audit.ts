/**
 * The immutable supplier log (spec §3.3, A18).
 *
 * Every call across the supply, payments and notification seams is wrapped here
 * rather than logged by hand at each call site, so it is impossible to add a new
 * outbound call that goes unrecorded.
 *
 * Nothing card-like is logged because nothing card-like exists: `CardIssuer`
 * cannot return a PAN (A13 is a property of the types). Personal data is kept to
 * what a dispute needs — traveller emails and names are not copied into the log,
 * because the log is append-only and erasure cannot reach back into it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { newId } from "../core/ids.ts";
import type { SourceLogEntry } from "../core/types.ts";
import type { Notifier } from "../notify/Notifier.ts";
import type { CardIssuer } from "../payments/CardIssuer.ts";
import type { RateSource, RateSourceCapabilities } from "../supply/RateSource.ts";
import type { Store } from "../store/Store.ts";

const correlation = new AsyncLocalStorage<string>();

/**
 * Log writes started during one HTTP request. On a store where every write is a
 * network round trip (Vercel Blob), awaiting each append before the booking logic
 * may continue put a blocking write between every supplier call, and an approval
 * crossed the 30s function limit. Writes now start immediately and run alongside
 * the rest of the request; the response is held until they all settle, so the log
 * is still complete before the traveller sees anything — and before a serverless
 * instance may be frozen.
 */
const pendingWrites = new AsyncLocalStorage<Promise<unknown>[]>();

/** Runs `fn` with `list` as the request's pending-write collector. */
export function runWithPendingWrites<T>(list: Promise<unknown>[], fn: () => T): T {
  return pendingWrites.run(list, fn);
}

/** Resolves once every write in `list`, including any started while waiting, has settled. */
export async function settleWrites(list: Promise<unknown>[]): Promise<void> {
  while (list.length > 0) {
    await Promise.allSettled(list.splice(0));
  }
}

/**
 * Groups every supplier and card call made inside `fn` under one correlation id.
 * Booking flows use the booking id, so a traveller's data export can collect the
 * log entries that belong to their bookings.
 */
export function withCorrelationId<T>(id: string, fn: () => T): T {
  return correlation.run(id, fn);
}

export function currentCorrelationId(): string | undefined {
  return correlation.getStore();
}

interface RecordArgs {
  readonly sourceId: string;
  readonly operation: SourceLogEntry["operation"];
  readonly correlationId: string;
  readonly request: unknown;
}

async function record<T>(
  store: Store,
  args: RecordArgs,
  run: () => Promise<T>,
  describe: (value: T) => unknown,
): Promise<T> {
  const startedAt = Date.now();
  const at = new Date().toISOString();
  let value: T;
  try {
    value = await run();
  } catch (err) {
    await track(append(store, args, at, startedAt, null, messageOf(err)));
    throw err;
  }
  await track(append(store, args, at, startedAt, describe(value), null));
  return value;
}

/** Inside a request, hand the write to the request's collector; outside one (cron, scripts), await it. */
async function track(write: Promise<void>): Promise<void> {
  const pending = pendingWrites.getStore();
  if (pending !== undefined) {
    pending.push(write);
    return;
  }
  await write;
}

async function append(
  store: Store,
  args: RecordArgs,
  at: string,
  startedAt: number,
  response: unknown,
  errorMessage: string | null,
): Promise<void> {
  const entry: SourceLogEntry = {
    id: newId("slog"),
    at,
    sourceId: args.sourceId,
    operation: args.operation,
    correlationId: args.correlationId,
    request: args.request,
    response,
    errorMessage,
    durationMs: Date.now() - startedAt,
  };
  try {
    await store.appendSourceLog(entry);
  } catch {
    // A log write must never fail a booking that the supplier already accepted.
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

const NO_CAPABILITIES: RateSourceCapabilities = {
  holds: false,
  maxHoldMinutes: 0,
  live: false,
  currencies: "any",
};

export function instrumentRateSource(
  src: RateSource,
  store: Store,
  correlationIdFor: () => string,
): RateSource {
  const corr = (): string => currentCorrelationId() ?? correlationIdFor();

  return {
    id: src.id,
    displayName: src.displayName,
    capabilities: src.capabilities ?? NO_CAPABILITIES,

    searchAvailability(query, signal) {
      return record(
        store,
        {
          sourceId: src.id,
          operation: "search",
          correlationId: corr(),
          request: {
            anchor: query.anchor.label,
            checkIn: query.checkIn,
            checkOut: query.checkOut,
            guests: query.guests,
            rooms: query.rooms,
          },
        },
        () => src.searchAvailability(query, signal),
        (offers) => ({ offerCount: offers.length, offerIds: offers.map((o) => o.rate.id) }),
      );
    },

    priceCheck(offerId, query) {
      return record(
        store,
        {
          sourceId: src.id,
          operation: "priceCheck",
          correlationId: corr(),
          request: { offerId, checkIn: query.checkIn, checkOut: query.checkOut },
        },
        () => src.priceCheck(offerId, query),
        (offer) =>
          offer === null ? { available: false } : { available: true, allInTotal: offer.rate.allInTotal },
      );
    },

    hold(req) {
      return record(
        store,
        {
          sourceId: src.id,
          operation: "hold",
          correlationId: req.correlationId,
          request: { offerId: req.offerId, expectedTotal: req.expectedTotal, minutes: req.minutes },
        },
        () => src.hold(req),
        (h) => h,
      );
    },

    releaseHold(holdRef) {
      return record(
        store,
        { sourceId: src.id, operation: "releaseHold", correlationId: corr(), request: { holdRef } },
        () => src.releaseHold(holdRef),
        () => ({ released: true }),
      );
    },

    book(req) {
      return record(
        store,
        {
          sourceId: src.id,
          operation: "book",
          correlationId: req.correlationId,
          request: {
            offerId: req.offerId,
            authorisedTotal: req.authorisedTotal,
            cardTokenRef: req.cardTokenRef,
            holdRef: req.holdRef,
          },
        },
        () => src.book(req),
        (booking) => booking,
      );
    },

    cancel(supplierBookingRef) {
      return record(
        store,
        { sourceId: src.id, operation: "cancel", correlationId: corr(), request: { supplierBookingRef } },
        () => src.cancel(supplierBookingRef),
        () => ({ cancelled: true }),
      );
    },
  };
}

export function instrumentCardIssuer(issuer: CardIssuer, store: Store): CardIssuer {
  return {
    id: issuer.id,
    capabilities: issuer.capabilities ?? { live: false, currencies: "any" },

    issue(req) {
      return record(
        store,
        {
          sourceId: issuer.id,
          operation: "issueCard",
          correlationId: req.correlationId,
          request: {
            exactTotal: req.exactTotal,
            incidentalsBufferMinor: req.incidentalsBufferMinor,
            entityId: req.entityId,
            reference: req.reference,
            validFrom: req.validFrom,
            validUntil: req.validUntil,
            merchantCategory: req.merchantCategory,
          },
        },
        () => issuer.issue(req),
        (card) => ({
          tokenRef: card.tokenRef,
          last4: card.last4,
          brand: card.brand,
          authorisedTotal: card.authorisedTotal,
        }),
      );
    },

    void(tokenRef) {
      return record(
        store,
        {
          sourceId: issuer.id,
          operation: "voidCard",
          correlationId: currentCorrelationId() ?? newId("corr"),
          request: { tokenRef },
        },
        () => issuer.void(tokenRef),
        () => ({ voided: true }),
      );
    },
  };
}

export function instrumentNotifier(notifier: Notifier, store: Store): Notifier {
  return {
    id: notifier.id,
    channel: notifier.channel,
    live: notifier.live,
    send(n) {
      return record(
        store,
        {
          sourceId: notifier.id,
          operation: "notify",
          correlationId: currentCorrelationId() ?? newId("corr"),
          request: { kind: n.kind, channel: notifier.channel, recipientId: n.recipient.id },
        },
        () => notifier.send(n),
        () => ({ delivered: true }),
      );
    },
  };
}
