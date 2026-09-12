/**
 * The immutable supplier log (spec §3.3, A18).
 *
 * Every call across the supply and payments seams is wrapped here rather than
 * logged by hand at each call site, so it is impossible to add a new supplier
 * call that goes unrecorded. Request, response, duration and error all land in
 * one append-only `SourceLogEntry`.
 *
 * Nothing is redacted, because there is nothing to redact: `CardIssuer` cannot
 * return a PAN and `SupplierBookRequest` carries a `cardTokenRef` only (A13 is
 * a property of the types, not of this file's discipline).
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { newId } from "../core/ids.ts";
import type { SourceLogEntry } from "../core/types.ts";
import type { CardIssuer } from "../payments/CardIssuer.ts";
import type { RateSource } from "../supply/RateSource.ts";
import type { Store } from "../store/Store.ts";

const correlation = new AsyncLocalStorage<string>();

/**
 * Groups every supplier and card call made inside `fn` under one correlation id,
 * so a booking attempt reads as a single story in the log.
 */
export function withCorrelationId<T>(id: string, fn: () => T): T {
  return correlation.run(id, fn);
}

/** The correlation id in force, if any. */
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
  try {
    const value = await run();
    await append(store, args, at, startedAt, describe(value), null);
    return value;
  } catch (err) {
    await append(store, args, at, startedAt, null, messageOf(err));
    throw err;
  }
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

export function instrumentRateSource(
  src: RateSource,
  store: Store,
  correlationIdFor: () => string,
): RateSource {
  const corr = (): string => currentCorrelationId() ?? correlationIdFor();

  return {
    id: src.id,
    displayName: src.displayName,

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
        (offers) => ({
          offerCount: offers.length,
          offerIds: offers.map((o) => o.rate.id),
        }),
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
          offer === null
            ? { available: false }
            : { available: true, allInTotal: offer.rate.allInTotal },
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
            travellerEmail: req.travellerEmail,
          },
        },
        () => src.book(req),
        (booking) => booking,
      );
    },

    cancel(supplierBookingRef) {
      return record(
        store,
        {
          sourceId: src.id,
          operation: "cancel",
          correlationId: corr(),
          request: { supplierBookingRef },
        },
        () => src.cancel(supplierBookingRef),
        () => ({ cancelled: true }),
      );
    },
  };
}

export function instrumentCardIssuer(issuer: CardIssuer, store: Store): CardIssuer {
  return {
    id: issuer.id,

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
