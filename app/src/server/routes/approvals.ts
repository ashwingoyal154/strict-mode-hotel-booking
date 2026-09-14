/**
 * Approvals, notifications, chat intent and the cron tick — the routes where more
 * than one person, or no person at all, acts on a booking.
 *
 * Every approval read goes through `approvals.ts`, which materialises SLA
 * escalations as of now before anything is returned. Scope filtering therefore
 * runs on the refreshed view: a request that has just escalated to Vikram is in
 * Vikram's queue on his very next read, whether or not any cron has run.
 */

import { Router } from "express";
import { z } from "zod";

import type { ApprovalState } from "../../core/types.ts";
import { canView, inMyScope, listApprovalViews, readApprovalView } from "../approvals.ts";
import { decideApproval } from "../bookings-service.ts";
import { tick } from "../cron.ts";
import { safeEqual } from "../signing.ts";
import { verifyActionToken } from "../tokens.ts";
import { fail, handler, parseBody, send, type ServerContext } from "./http.ts";

const STATES = ["pending", "approved", "rejected", "withdrawn"] as const;

const decisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).optional(),
  actionToken: z.string().min(10).max(4000).optional(),
});

const intentBody = z.object({ text: z.string().trim().min(1).max(500) });

/** Chat entry resolves in the traveller's zone; Slice 2 is India-first. */
const INTENT_TIME_ZONE = "Asia/Kolkata";

function parseState(raw: unknown): ApprovalState | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" && (STATES as readonly string[]).includes(raw) ? (raw as ApprovalState) : null;
}

export function approvalRoutes(ctx: ServerContext): Router {
  const router = Router();

  // ---------- approvals ----------

  router.get(
    "/approvals",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const scope = req.query.scope === "entity" ? "entity" : "mine";
      if (scope === "entity" && !traveller.isAdmin) {
        fail(res, 403, "forbidden", "Only a travel administrator can see every request.");
        return;
      }
      const state = parseState(req.query.state);
      if (state === null) {
        fail(res, 400, "invalid_request", `state must be one of ${STATES.join(", ")}.`);
        return;
      }
      const views = await listApprovalViews(ctx, traveller.entityId, state === undefined ? {} : { state });
      const approvals =
        scope === "entity"
          ? views
          : views.filter((v) => (v.state === "pending" ? inMyScope(v, traveller.id) : v.chain.includes(traveller.id)));
      res.status(200).json({ approvals });
    }),
  );

  // Registered before /approvals/:id so "action" is never read as an id.
  router.get(
    "/approvals/action/:token",
    handler(async (req, res) => {
      const token = req.params.token ?? "";
      const verified = verifyActionToken(token, ctx.now());
      if (!verified.ok) {
        res.status(200).json({ valid: false, reason: verified.reason });
        return;
      }
      const approval = await ctx.store.getApproval(verified.claims.approvalId);
      if (approval === null) {
        res.status(200).json({ valid: false, reason: "That request no longer exists." });
        return;
      }
      const view = await readApprovalView(ctx, approval);
      if (view.state !== "pending") {
        res.status(200).json({ valid: false, reason: `This request has already been ${view.state}.` });
        return;
      }
      const approver = await ctx.store.getTraveller(verified.claims.approverId);
      res.status(200).json({
        valid: true,
        decision: verified.claims.decision,
        approval: view,
        approverName: approver?.name ?? "Approver",
      });
    }),
  );

  router.get(
    "/approvals/:approvalId",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const approval = await ctx.store.getApproval(req.params.approvalId ?? "");
      if (approval === null) {
        fail(res, 404, "not_found", "That approval request does not exist.");
        return;
      }
      if (!canView(approval, traveller)) {
        fail(res, 403, "forbidden", "That request is not yours to see.");
        return;
      }
      res.status(200).json({ approval: await readApprovalView(ctx, approval) });
    }),
  );

  // Authorised by a session OR a one-tap token, so no requireAuth here; the
  // service decides which applies and rejects when neither does.
  router.post(
    "/approvals/:approvalId/decision",
    handler(async (req, res) => {
      const body = parseBody(decisionBody, req, res);
      if (body === null) return;
      send(
        res,
        await decideApproval(ctx, {
          approvalId: req.params.approvalId ?? "",
          decision: body.decision,
          note: body.note ?? null,
          actionToken: body.actionToken,
          sessionTraveller: req.traveller,
        }),
      );
    }),
  );

  // ---------- notifications ----------

  router.get(
    "/notifications",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const notifications = await ctx.store.listNotificationsFor(traveller.id, 100);
      res.status(200).json({ notifications, unread: notifications.filter((n) => n.readAt === null).length });
    }),
  );

  router.post(
    "/notifications/:notificationId/read",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      const id = req.params.notificationId ?? "";
      const mine = (await ctx.store.listNotificationsFor(traveller.id, 500)).find((n) => n.id === id);
      if (mine === undefined) {
        fail(res, 404, "not_found", "That notification does not exist.");
        return;
      }
      const at = ctx.now().toISOString();
      const notification = await ctx.store.mutateNotification(id, (n) => (n.readAt === null ? { ...n, readAt: at } : n));
      res.status(200).json({ notification });
    }),
  );

  // ---------- chat entry ----------

  router.post(
    "/intent",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const body = parseBody(intentBody, req, res);
      if (body === null) return;
      const intent = await ctx.intentParser.parse(body.text, {
        now: ctx.now(),
        timeZone: INTENT_TIME_ZONE,
        anchors: ctx.knownAnchors,
        resolveAnchor: ctx.resolveAnchor,
      });
      // A complete, confident intent becomes a search request the client posts
      // itself. There is no path from here to a booking (spec §2.3).
      const complete =
        intent.clarification === null && intent.anchor !== null && intent.checkIn !== null && intent.checkOut !== null;
      const searchRequest = complete
        ? {
            anchorQuery: intent.anchor?.label ?? intent.anchorQuery ?? "",
            checkIn: intent.checkIn,
            checkOut: intent.checkOut,
            guests: intent.guests ?? 1,
            rooms: intent.rooms ?? 1,
          }
        : null;
      res.status(200).json({ intent, searchRequest });
    }),
  );

  // ---------- cron ----------

  router.all(
    "/cron/tick",
    handler(async (req, res) => {
      const secret = process.env.CRON_SECRET;
      const header = req.header("Authorization") ?? "";
      const bySecret = secret !== undefined && secret !== "" && safeEqual(header, `Bearer ${secret}`);
      const byDemoAdmin = ctx.demo && req.traveller?.isAdmin === true;
      if (!bySecret && !byDemoAdmin) {
        fail(res, 401, "unauthenticated", "The tick needs the cron secret.");
        return;
      }
      res.status(200).json(await tick(ctx, ctx.now()));
    }),
  );

  return router;
}
