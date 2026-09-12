/**
 * Admin routes. Policy is versioned and append-only in effect: a save writes a
 * new version and every prior version stays readable, because A12 replays a
 * booking's verdict against *the version that applied at the time*, not against
 * today's rules.
 */

import { Router } from "express";
import { z } from "zod";

import type { Policy, Traveller } from "../../core/types.ts";
import { bookingsCsv } from "../csv.ts";
import { fail, handler, parseBody, type ServerContext } from "./http.ts";

const moneySchema = z.object({
  minor: z.number().int().min(0),
  currency: z.string().trim().length(3),
});

const policyBody = z.object({
  entityId: z.string().trim().min(1).optional(),
  caps: z
    .array(
      z.object({
        cityTier: z.string().trim().min(1),
        city: z.string().trim().min(1).nullable(),
        perNight: moneySchema,
      }),
    )
    .min(1, "a policy needs at least one nightly cap"),
  requireFlexible: z.boolean(),
  blockedCountries: z.array(z.string().trim().length(2, "use ISO 3166-1 alpha-2")),
  blockedSuppliers: z.array(z.string().trim().min(1)),
  costCentres: z.array(z.string().trim().min(1)).min(1, "at least one cost centre is required"),
  defaultCostCentre: z.string().trim().min(1),
  incidentalsBufferMinor: z.number().int().min(0),
});

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 1000;

export function adminRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.get(
    "/admin/policy",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const policy = await ctx.policyFor(admin.entityId);
      res.status(200).json({ policy });
    }),
  );

  router.put(
    "/admin/policy",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;

      const parsed = policyBody.safeParse(req.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        fail(
          res,
          400,
          "invalid_policy",
          first === undefined
            ? "That policy is not valid."
            : `${first.path.join(".") || "policy"}: ${first.message}`,
          { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        );
        return;
      }
      const body = parsed.data;

      if (!body.costCentres.includes(body.defaultCostCentre)) {
        fail(
          res,
          400,
          "invalid_policy",
          "defaultCostCentre must be one of the listed cost centres.",
        );
        return;
      }

      const currencies = new Set(body.caps.map((c) => c.perNight.currency));
      if (currencies.size > 1) {
        // Slice 1 runs a single currency; caps are authored per currency in slice 2
        // and a mixed list here would silently pick a winner.
        fail(res, 400, "invalid_policy", "Slice 1 supports one cap currency per policy.");
        return;
      }

      const entityId = body.entityId ?? admin.entityId;
      const current = await ctx.store.getCurrentPolicy(entityId);
      const next: Policy = {
        version: (current?.version ?? 0) + 1,
        entityId,
        caps: body.caps,
        requireFlexible: body.requireFlexible,
        blockedCountries: body.blockedCountries.map((c) => c.toUpperCase()),
        blockedSuppliers: body.blockedSuppliers,
        costCentres: body.costCentres,
        defaultCostCentre: body.defaultCostCentre,
        incidentalsBufferMinor: body.incidentalsBufferMinor,
        updatedAt: ctx.now().toISOString(),
        updatedBy: admin.email,
      };
      await ctx.store.savePolicy(next);
      res.status(200).json({ policy: next });
    }),
  );

  router.get(
    "/admin/bookings.csv",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const [bookings, travellers] = await Promise.all([
        ctx.store.listBookingsForEntity(admin.entityId),
        ctx.store.listTravellers(),
      ]);
      const emails = new Map<string, string>(travellers.map((t: Traveller) => [t.id, t.email]));
      res
        .status(200)
        .type("text/csv; charset=utf-8")
        .setHeader("Content-Disposition", 'attachment; filename="bookings.csv"');
      res.send(bookingsCsv(bookings, (id) => emails.get(id) ?? ""));
    }),
  );

  router.get(
    "/admin/bookings",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const bookings = await ctx.store.listBookingsForEntity(admin.entityId);
      res.status(200).json({ bookings });
    }),
  );

  router.get(
    "/admin/source-log",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const raw = req.query.limit;
      const asNumber = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
      const limit = Number.isFinite(asNumber)
        ? Math.min(Math.max(asNumber, 1), MAX_LOG_LIMIT)
        : DEFAULT_LOG_LIMIT;
      const entries = await ctx.store.listSourceLog(limit);
      res.status(200).json({ entries });
    }),
  );

  return router;
}
