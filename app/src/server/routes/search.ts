/**
 * Search routes.
 *
 * `POST /api/search` returns in milliseconds with a session id; it does not wait
 * for supply. The results arrive over SSE as each source answers, which is the
 * designed waiting state (DESIGN.md rule 4), not a loading spinner over a
 * blocking request.
 */

import { Router } from "express";
import { z } from "zod";

import { nightsBetween } from "../../core/commute.ts";
import { resolveAnchor } from "../../supply/fixtures/anchors.ts";
import type { SearchQuery } from "../../core/types.ts";
import { fail, handler, ISO_DATE, parseBody, type ServerContext } from "./http.ts";
import type { SearchEvent, SearchSession } from "../search.ts";

const searchBody = z.object({
  anchorQuery: z.string().trim().min(2, "tell us where your meeting is").max(200),
  checkIn: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
  checkOut: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
  guests: z.number().int().min(1).max(8).optional(),
  rooms: z.number().int().min(1).max(4).optional(),
});

const KEEPALIVE_MS = 15_000;

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

      const anchor = resolveAnchor(body.anchorQuery);
      if (anchor === null) {
        fail(
          res,
          400,
          "anchor_not_found",
          `We could not find "${body.anchorQuery}". Try a landmark, office or business district.`,
        );
        return;
      }

      if (nightsBetween(body.checkIn, body.checkOut) < 1) {
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

      const policy = await ctx.policyFor(traveller.entityId);
      const session = ctx.searches.create({ query, policy, travellerId: traveller.id });

      res.status(202).json({
        searchId: session.id,
        anchor,
        query: {
          anchorQuery: body.anchorQuery,
          checkIn: query.checkIn,
          checkOut: query.checkOut,
          guests: query.guests,
          rooms: query.rooms,
          nights: nightsBetween(query.checkIn, query.checkOut),
        },
        sources: ctx.sources.map((s) => ({ id: s.id, displayName: s.displayName })),
      });
    }),
  );

  router.get("/search/:searchId/events", ctx.auth.requireAuth, (req, res) => {
    const session = findSession(ctx, req.params.searchId);
    if (session === undefined) {
      fail(res, 404, "search_not_found", "That search has expired. Search again.");
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Akamai / nginx will otherwise buffer the stream and defeat the whole point.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let closed = false;
    const keepalive = setInterval(() => {
      if (!closed) res.write(": keepalive\n\n");
    }, KEEPALIVE_MS);

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

    const unsubscribe = session.subscribe(send);

    req.on("close", () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  router.get(
    "/search/:searchId",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const session = findSession(ctx, req.params.searchId);
      if (session === undefined) {
        fail(res, 404, "search_not_found", "That search has expired. Search again.");
        return;
      }
      // The settled snapshot is what the confirm screen and a page reload read,
      // so it waits for the fan-out rather than returning a partial list.
      await session.settled();
      const snap = session.snapshot();
      res.status(200).json({
        searchId: session.id,
        anchor: session.query.anchor,
        query: {
          checkIn: session.query.checkIn,
          checkOut: session.query.checkOut,
          guests: session.query.guests,
          rooms: session.query.rooms,
          nights: nightsBetween(session.query.checkIn, session.query.checkOut),
        },
        results: snap.results,
        sources: snap.sources,
        blockedCount: snap.blockedCount,
        policyVersion: session.policy.version,
        durationMs: snap.durationMs,
      });
    }),
  );

  return router;
}

function findSession(ctx: ServerContext, id: string | undefined): SearchSession | undefined {
  if (id === undefined) return undefined;
  return ctx.searches.get(id);
}
