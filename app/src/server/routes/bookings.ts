/**
 * Booking routes — where the product's two promises are actually kept.
 *
 * 1. **Policy is enforced here, not in the UI (A6).** The verdict is recomputed
 *    server-side from the freshly price-checked rate against the *current*
 *    policy version. Nothing the client sends about policy is read, so posting a
 *    blocked offer straight at this endpoint is rejected exactly as the hidden
 *    card in the UI is.
 *
 * 2. **`acceptedTotal` makes a silent re-price impossible (A3).** The client
 *    echoes the number it displayed; the server re-prices with the source and
 *    compares. Equal → book. Different → 409 with the delta and a re-confirm.
 *    There is no branch in which a changed price is absorbed.
 *
 * Idempotency (A14) is enforced twice: by a durable lookup on the stored
 * booking, and by an in-process gate so that two *concurrent* posts of the same
 * key share one execution — one supplier call, one card, one booking.
 */

import { Router } from "express";
import { z } from "zod";

import { assertTransition, isCancellableAt } from "../../core/booking.ts";
import { isValidIdempotencyKey, newConfirmationCode, newId } from "../../core/ids.ts";
import { evaluate } from "../../core/policy.ts";
import { driftBetween } from "../../core/pricing.ts";
import type {
  Booking,
  IssuedCard,
  Money,
  Offer,
  Policy,
  PriceDriftDetail,
  Traveller,
} from "../../core/types.ts";
import { CardDeclinedError } from "../../payments/CardIssuer.ts";
import {
  SupplierPriceDriftError,
  SupplierSoldOutError,
  type RateSource,
} from "../../supply/RateSource.ts";
import { withCorrelationId } from "../audit.ts";
import type { SearchSession } from "../search.ts";
import { fail, handler, parseBody, type ServerContext } from "./http.ts";

const moneySchema = z.object({
  minor: z.number().int("money is integer minor units, never a float"),
  currency: z.string().trim().length(3),
});

const createBookingBody = z.object({
  searchId: z.string().trim().min(1),
  offerId: z.string().trim().min(1),
  costCentre: z.string().trim().min(1).max(64).optional(),
  acceptedTotal: moneySchema,
});

/** A request that has been answered already; the envelope is replayed verbatim. */
interface Answered {
  readonly status: number;
  readonly body: unknown;
  /** Only a success is remembered; a failure must be retryable on the same key. */
  readonly booking: Booking | null;
}

function freeze<T>(value: T): T {
  // The booking's offer/commute/verdict must be copies. A snapshot that aliases
  // live supply is not a snapshot, and A12 replay would drift with it.
  return structuredClone(value);
}

export function bookingRoutes(ctx: ServerContext): Router {
  const router = Router();

  /** key -> in-flight or just-completed execution. */
  const inFlight = new Map<string, Promise<Answered>>();

  router.post(
    "/bookings",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;

      const rawKey = req.header("Idempotency-Key");
      if (rawKey === undefined || rawKey.trim() === "") {
        fail(
          res,
          400,
          "idempotency_key_required",
          "Idempotency-Key header is required so a double submit cannot create two bookings.",
        );
        return;
      }
      const key = rawKey.trim();
      if (!isValidIdempotencyKey(key)) {
        fail(
          res,
          400,
          "invalid_idempotency_key",
          "Idempotency-Key must be 8 to 200 printable characters.",
        );
        return;
      }

      const body = parseBody(createBookingBody, req, res);
      if (body === null) return;

      // Durable replay: the key was already used in an earlier process lifetime.
      const already = await ctx.store.getBookingByIdempotencyKey(key);
      if (already !== null) {
        replay(res, already, traveller);
        return;
      }

      const existing = inFlight.get(key);
      if (existing !== undefined) {
        // Concurrent double submit: ride the first execution rather than start a
        // second one. This is what makes A14 hold under a real double tap.
        const answer = await existing;
        if (answer.booking !== null) {
          replay(res, answer.booking, traveller);
          return;
        }
        res.status(answer.status).json(answer.body);
        return;
      }

      const run = attempt({ ctx, traveller, key, body }).catch(
        (err: unknown): Answered => ({
          status: 500,
          body: {
            error: {
              code: "internal_error",
              message: "Something went wrong. Your card was not charged.",
              detail: { message: err instanceof Error ? err.message : String(err) },
            },
          },
          booking: null,
        }),
      );
      inFlight.set(key, run);

      const answer = await run;
      // A success stays resolvable from the store; only the in-process entry for a
      // failed attempt is dropped, so the traveller can retry on the same key.
      if (answer.booking === null) inFlight.delete(key);

      res.status(answer.status).json(answer.body);
    }),
  );

  router.get(
    "/bookings",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const bookings = await ctx.store.listBookingsForTraveller(traveller.id);
      res.status(200).json({ bookings });
    }),
  );

  router.get(
    "/bookings/:id",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const booking = await loadOwn(ctx, req.params.id, traveller, res);
      if (booking === null) return;
      res.status(200).json({ booking });
    }),
  );

  router.post(
    "/bookings/:id/cancel",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const booking = await loadOwn(ctx, req.params.id, traveller, res);
      if (booking === null) return;

      if (booking.state === "cancelled") {
        // Idempotent: a second tap on Cancel is not an error.
        res.status(200).json({ booking });
        return;
      }

      if (!isCancellableAt(booking, ctx.now())) {
        fail(
          res,
          409,
          "outside_free_window",
          booking.cancellationDeadline === null
            ? "This rate is non-refundable, so it cannot be cancelled for free."
            : "The free-cancellation window has closed. Contact support to cancel this trip.",
          { cancellationDeadline: booking.cancellationDeadline },
        );
        return;
      }

      const source = sourceFor(ctx, booking.offer.rate.sourceId);
      if (source === undefined) {
        fail(res, 503, "source_unavailable", "We cannot reach the hotel's system right now.");
        return;
      }

      const correlationId = newId("corr");
      try {
        await withCorrelationId(correlationId, async () => {
          if (booking.supplierBookingRef !== null) {
            await source.cancel(booking.supplierBookingRef);
          }
          if (booking.card !== null) {
            // Void before persisting: an un-voided card on a cancelled booking is
            // a live authorisation against the company.
            await ctx.issuer.void(booking.card.tokenRef);
          }
        });
      } catch {
        fail(res, 503, "source_unavailable", "We could not reach the hotel to cancel. Try again.");
        return;
      }

      assertTransition(booking.state, "cancelled");
      const cancelled: Booking = {
        ...booking,
        state: "cancelled",
        cancelledAt: ctx.now().toISOString(),
      };
      await ctx.store.putBooking(cancelled);
      res.status(200).json({ booking: cancelled });
    }),
  );

  return router;
}

function replay(res: import("express").Response, booking: Booking, traveller: Traveller): void {
  if (booking.travellerId !== traveller.id) {
    fail(
      res,
      409,
      "idempotency_key_conflict",
      "That idempotency key belongs to another traveller's booking.",
    );
    return;
  }
  res.status(200).json({ booking });
}

async function loadOwn(
  ctx: ServerContext,
  id: string | undefined,
  traveller: Traveller,
  res: import("express").Response,
): Promise<Booking | null> {
  if (id === undefined) {
    fail(res, 404, "not_found", "That trip does not exist.");
    return null;
  }
  const booking = await ctx.store.getBooking(id);
  if (booking === null) {
    fail(res, 404, "not_found", "That trip does not exist.");
    return null;
  }
  if (booking.travellerId !== traveller.id) {
    fail(res, 403, "forbidden", "That trip belongs to another traveller.");
    return null;
  }
  return booking;
}

function sourceFor(ctx: ServerContext, sourceId: string): RateSource | undefined {
  return ctx.sources.find((s) => s.id === sourceId);
}

interface AttemptArgs {
  readonly ctx: ServerContext;
  readonly traveller: Traveller;
  readonly key: string;
  readonly body: {
    readonly searchId: string;
    readonly offerId: string;
    readonly costCentre?: string | undefined;
    readonly acceptedTotal: Money;
  };
}

const err = (status: number, code: string, message: string, detail?: unknown): Answered => {
  const error: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) error.detail = detail;
  return { status, body: { error }, booking: null };
};

/**
 * One booking attempt, in the only order that is safe:
 * price-check → policy → drift → issue card → book with the source → persist.
 * Policy precedes drift because a blocked rate is not bookable at any price.
 */
async function attempt(args: AttemptArgs): Promise<Answered> {
  const { ctx, traveller, key, body } = args;

  const session: SearchSession | undefined = ctx.searches.get(body.searchId);
  if (session === undefined) {
    return err(404, "search_not_found", "That search has expired. Search again to get live prices.");
  }
  const ranked = session.find(body.offerId);
  if (ranked === undefined) {
    return err(404, "offer_not_found", "That room is no longer part of this search.");
  }

  const policy: Policy = await ctx.policyFor(traveller.entityId);
  const costCentre = body.costCentre ?? traveller.defaultCostCentre ?? policy.defaultCostCentre;
  if (!policy.costCentres.includes(costCentre)) {
    return err(400, "invalid_cost_centre", `"${costCentre}" is not a cost centre on your policy.`, {
      costCentres: policy.costCentres,
    });
  }

  const source = sourceFor(ctx, ranked.offer.rate.sourceId);
  if (source === undefined) {
    return err(503, "source_unavailable", "We cannot reach the hotel's system right now.");
  }

  const correlationId = newId("corr");

  return withCorrelationId(correlationId, async (): Promise<Answered> => {
    // --- re-price. The source's answer is authoritative, never the cached rate.
    let fresh: Offer | null;
    try {
      fresh = await source.priceCheck(body.offerId, session.query);
    } catch {
      return err(503, "source_unavailable", "We could not confirm this rate. Try again in a moment.");
    }
    if (fresh === null) {
      return err(410, "sold_out", "That room has just sold out. Here are the next best options.");
    }

    // --- policy, recomputed server-side (A6).
    const verdict = evaluate({ rate: fresh.rate, property: fresh.property, policy });
    if (verdict.state === "blocked") {
      return err(403, "blocked_by_policy", verdict.reason, { verdict });
    }

    // --- price parity (A3).
    const drift: PriceDriftDetail | null = driftBetween(body.acceptedTotal, fresh.rate.allInTotal);
    if (drift !== null) {
      return err(409, "price_drift", drift.message, drift);
    }

    const bookingId = newId("bkg");
    const authorisedTotal = fresh.rate.allInTotal;

    // --- central billing. The traveller makes no payment decision (A9).
    let card: IssuedCard;
    try {
      card = await ctx.issuer.issue({
        exactTotal: authorisedTotal,
        incidentalsBufferMinor: policy.incidentalsBufferMinor,
        entityId: traveller.entityId,
        reference: bookingId,
        correlationId,
      });
    } catch (issueError) {
      if (issueError instanceof CardDeclinedError) {
        return err(
          402,
          "card_declined",
          "The company card was declined. Our travel desk has been notified.",
          { declineCode: issueError.declineCode },
        );
      }
      return err(503, "source_unavailable", "We could not issue the company card. Try again.");
    }

    // --- book. Every failure past this point voids the card it just issued.
    try {
      const supplier = await source.book({
        offerId: body.offerId,
        query: session.query,
        travellerName: traveller.name,
        travellerEmail: traveller.email,
        authorisedTotal,
        cardTokenRef: card.tokenRef,
        correlationId,
      });

      const confirmedDrift = driftBetween(authorisedTotal, supplier.confirmedTotal);
      if (confirmedDrift !== null) {
        // The source came back with a different number than it was authorised for.
        // That is drift, and it surfaces — it is never absorbed.
        await voidQuietly(ctx, card.tokenRef);
        return err(409, "price_drift", confirmedDrift.message, confirmedDrift);
      }

      const booking: Booking = {
        id: bookingId,
        confirmationCode: newConfirmationCode(),
        travellerId: traveller.id,
        entityId: traveller.entityId,
        state: "confirmed",
        offer: freeze(fresh),
        commute: freeze(ranked.commute),
        verdict: freeze(verdict),
        anchor: freeze(session.query.anchor),
        costCentre,
        card,
        cancellationDeadline: supplier.cancellationDeadline,
        createdAt: ctx.now().toISOString(),
        cancelledAt: null,
        idempotencyKey: key,
        supplierBookingRef: supplier.supplierBookingRef,
      };
      assertTransition("searched", booking.state);
      await ctx.store.putBooking(booking);

      return { status: 201, body: { booking }, booking };
    } catch (bookError) {
      await voidQuietly(ctx, card.tokenRef);
      if (bookError instanceof SupplierPriceDriftError) {
        const late =
          driftBetween(body.acceptedTotal, bookError.currentTotal) ??
          driftBetween(bookError.previousTotal, bookError.currentTotal);
        if (late !== null) return err(409, "price_drift", late.message, late);
        return err(409, "price_drift", "The price changed while we were booking.", {
          kind: "price_drift",
          acceptedTotal: body.acceptedTotal,
          currentTotal: bookError.currentTotal,
          deltaMinor: bookError.currentTotal.minor - body.acceptedTotal.minor,
          message: "The price changed while we were booking.",
        });
      }
      if (bookError instanceof SupplierSoldOutError) {
        return err(410, "sold_out", "That room sold out as we were booking it.");
      }
      return err(503, "source_unavailable", "The hotel's system did not respond. Nothing was charged.");
    }
  });
}

async function voidQuietly(ctx: ServerContext, tokenRef: string): Promise<void> {
  try {
    await ctx.issuer.void(tokenRef);
  } catch {
    // Logged by audit.ts. A failed void must not mask the real failure the
    // traveller needs to see; reconciliation owns the orphan.
  }
}
