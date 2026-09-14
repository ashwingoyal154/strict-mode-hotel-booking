/**
 * Search routes.
 *
 * `POST /api/search` returns in milliseconds with a signed, self-describing search
 * id; it does not wait for supply. Results arrive over SSE as each source answers —
 * the designed waiting state (DESIGN.md rule 4), not a spinner over a blocking
 * request. Because the id carries its own query, any instance can serve the
 * events stream or the settled snapshot, which is what makes this work on
 * serverless.
 */

import { Router, type Response } from "express";
import { z } from "zod";

import { nightsBetween } from "../../core/commute.ts";
import { pinMonthOf } from "../../core/fx.ts";
import type { SearchQuery } from "../../core/types.ts";
import type { SearchEvent, SearchSession } from "../search.ts";
import { fail, handler, ISO_DATE, parseBody, type ServerContext } from "./http.ts";

const searchBody = z.object({
  anchorQuery: z.string().trim().min(2, "tell us where your meeting is").max(200),
  checkIn: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
  checkOut: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
  guests: z.number().int().min(1).max(8).optional(),
  rooms: z.number().int().min(1).max(4).optional(),
  displayCurrency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code").optional(),
});

const KEEPALIVE_MS = 15_000;

function querySummary(session: SearchSession) {
  return {
    checkIn: session.query.checkIn,
    checkOut: session.query.checkOut,
    guests: session.query.guests,
    rooms: session.query.rooms,
    nights: nightsBetween(session.query.checkIn, session.query.checkOut),
  };
}

/** Resolves a search for its owner, answering 404/410 itself. Returns null when it has. */
async function sessionFor(ctx: ServerContext, id: string | undefined, travellerId: string, res: Response) {
  if (id === undefined) {
    fail(res, 404, "search_not_found", "That search does not exist. Search again.");
    return null;
  }
  const lookup = await ctx.searches.resolve(id, travellerId);
  if (!lookup.ok) {
    fail(res, lookup.status, lookup.code, lookup.message);
    return null;
  }
  return lookup.session;
}

export function searchRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.post(
    "/search",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const body = parseBody(searchBody, req, res);
      if (body === null) return;

      const anchor = ctx.resolveAnchor(body.anchorQuery);
      if (anchor === null) {
        fail(
          res,
          400,
          "anchor_not_found",
          `We could not find "${body.anchorQuery}". Try a landmark, office or business district.`,
        );
        return;
      }
      if (body.checkOut <= body.checkIn || nightsBetween(body.checkIn, body.checkOut) < 1) {
        fail(res, 400, "invalid_request", "Check-out must be after check-in.");
        return;
      }

      const query: SearchQuery = {
        anchor,
        checkIn: body.checkIn,
        checkOut: body.checkOut,
        guests: body.guests ?? 1,
        rooms: body.rooms ?? 1,
      };

      const now = ctx.now();
      const pinMonth = pinMonthOf(now);
      const [policy, entity, fxPins] = await Promise.all([
        ctx.policyFor(traveller.entityId),
        ctx.entityFor(traveller.entityId),
        ctx.store.getFxPins(pinMonth),
      ]);
      const displayCurrency = body.displayCurrency ?? traveller.displayCurrency ?? entity.reportingCurrency;

      const session = await ctx.searches.create({
        query,
        policy,
        travellerId: traveller.id,
        entityId: traveller.entityId,
        displayCurrency,
        pinMonth,
        fxPins,
      });

      res.status(202).json({
        searchId: session.id,
        anchor,
        query: { anchorQuery: body.anchorQuery, ...querySummary(session) },
        sources: ctx.sources.map((s) => ({ id: s.id, displayName: s.displayName })),
        displayCurrency: session.displayCurrency,
        fxPinMonth: session.pinMonth,
      });
    }),
  );

  router.get(
    "/search/:searchId/events",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const session = await sessionFor(ctx, req.params.searchId, traveller.id, res);
      if (session === null) return;

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // Proxies otherwise buffer the stream and defeat the whole point.
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      let closed = false;
      const keepalive = setInterval(() => {
        if (!closed) res.write(": keepalive\n\n");
      }, KEEPALIVE_MS);

      let unsubscribe: () => void = () => undefined;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        res.end();
      };

      const send = (event: SearchEvent): void => {
        if (closed) return;
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        if (event.event === "done") finish();
      };

      unsubscribe = session.subscribe(send);

      req.on("close", () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
      });
    }),
  );

  router.get(
    "/search/:searchId",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const session = await sessionFor(ctx, req.params.searchId, traveller.id, res);
      if (session === null) return;
      // The settled snapshot is what the confirm screen and a reload read, so it
      // waits for the fan-out rather than returning a partial list.
      await session.settled();
      const snap = session.snapshot();
      res.status(200).json({
        searchId: session.id,
        anchor: session.query.anchor,
        query: querySummary(session),
        results: snap.results,
        sources: snap.sources,
        blockedCount: snap.blockedCount,
        policyVersion: session.policy.version,
        durationMs: snap.durationMs,
        displayCurrency: session.displayCurrency,
        fxPinMonth: session.pinMonth,
      });
    }),
  );

  return router;
}
