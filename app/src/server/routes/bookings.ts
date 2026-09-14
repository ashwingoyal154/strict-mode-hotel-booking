/**
 * Booking routes. Thin by design: every money decision — idempotency, price
 * check, policy, drift, hold, card, supplier write — lives in
 * `bookings-service.ts`, in one order, tested once. A route only authenticates,
 * checks ownership, validates the body and hands over.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import type { Booking } from "../../core/types.ts";
import {
  approvalViewFor,
  cancelBooking,
  createBookingBody,
  invoiceFor,
  modifyBody,
  modifyBooking,
  modifyQuoteBody,
  quoteModification,
  readIdempotencyKey,
  reportDeskDecline,
  requestBooking,
  withdrawBooking,
} from "../bookings-service.ts";
import { authorisationLetterHtml } from "../letters.ts";
import { fail, handler, parseBody, send, type ServerContext } from "./http.ts";

const deskDeclineBody = z.object({ note: z.string().trim().max(500).optional() });

/** The caller's own booking (or any booking, for an admin), answering 404/403 itself. */
async function ownedBooking(ctx: ServerContext, req: Request, res: Response): Promise<Booking | null> {
  const traveller = req.traveller;
  if (traveller === undefined) return null;
  const id = req.params.bookingId;
  const booking = id === undefined ? null : await ctx.store.getBooking(id);
  if (booking === null) {
    fail(res, 404, "not_found", "That trip does not exist.");
    return null;
  }
  if (booking.travellerId !== traveller.id && !(traveller.isAdmin && booking.entityId === traveller.entityId)) {
    fail(res, 403, "forbidden", "That trip belongs to another traveller.");
    return null;
  }
  return booking;
}

export function bookingRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.post(
    "/bookings",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const idem = readIdempotencyKey(req.header("Idempotency-Key"));
      if (!("key" in idem)) {
        send(res, idem);
        return;
      }
      const body = parseBody(createBookingBody, req, res);
      if (body === null) return;
      send(res, await requestBooking(ctx, traveller, idem.key, body));
    }),
  );

  router.get(
    "/bookings",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const bookings = await ctx.store.listBookingsForTraveller(traveller.id);
      bookings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      res.status(200).json({ bookings });
    }),
  );

  router.get(
    "/bookings/:bookingId",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null) return;
      const [approval, invoice] = await Promise.all([
        approvalViewFor(ctx, booking),
        ctx.store.getInvoiceForBooking(booking.id),
      ]);
      res.status(200).json({ booking, approval, invoice });
    }),
  );

  router.post(
    "/bookings/:bookingId/cancel",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null) return;
      send(res, await cancelBooking(ctx, booking));
    }),
  );

  router.post(
    "/bookings/:bookingId/withdraw",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null) return;
      send(res, await withdrawBooking(ctx, booking));
    }),
  );

  router.post(
    "/bookings/:bookingId/modify/quote",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null || traveller === undefined) return;
      const body = parseBody(modifyQuoteBody, req, res);
      if (body === null) return;
      send(res, await quoteModification(ctx, traveller, booking, body));
    }),
  );

  router.post(
    "/bookings/:bookingId/modify",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null || traveller === undefined) return;
      const idem = readIdempotencyKey(req.header("Idempotency-Key"));
      if (!("key" in idem)) {
        send(res, idem);
        return;
      }
      const body = parseBody(modifyBody, req, res);
      if (body === null) return;
      send(res, await modifyBooking(ctx, traveller, booking, idem.key, body));
    }),
  );

  router.get(
    "/bookings/:bookingId/invoice",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null) return;
      send(res, await invoiceFor(ctx, booking));
    }),
  );

  router.get(
    "/bookings/:bookingId/authorisation-letter",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null) return;
      if (booking.card === null) {
        fail(res, 409, "no_card", "No card has been issued for this trip yet.");
        return;
      }
      const [traveller, entity] = await Promise.all([
        ctx.store.getTraveller(booking.travellerId),
        ctx.entityFor(booking.entityId),
      ]);
      const html = authorisationLetterHtml({ booking, card: booking.card, traveller, entity, issuedAt: ctx.now() });
      res.status(200).type("text/html; charset=utf-8").send(html);
    }),
  );

  router.post(
    "/bookings/:bookingId/card-declined",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      const booking = await ownedBooking(ctx, req, res);
      if (booking === null || traveller === undefined) return;
      const body = parseBody(deskDeclineBody, req, res);
      if (body === null) return;
      send(res, await reportDeskDecline(ctx, traveller, booking, body.note ?? null));
    }),
  );

  return router;
}
