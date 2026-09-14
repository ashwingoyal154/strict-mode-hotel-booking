/**
 * Admin routes. Policy is versioned and append-only in effect: a save writes a new
 * version and every prior version stays readable, because A12 replays a booking's
 * verdict against the version that applied at the time, not today's rules.
 *
 * Slice 2 adds the entity, monthly FX pins, the directory, the exception list,
 * duty of care, data rights and the launch metrics.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { summariseByCountry, travellersInMarket } from "../../core/duty.ts";
import { pinMonthOf } from "../../core/fx.ts";
import { isValidGstin } from "../../core/gst.ts";
import type { ApprovalRequest, FxRate, Invoice, Policy, Traveller } from "../../core/types.ts";
import { listApprovalViews } from "../approvals.ts";
import { normaliseEmail } from "../auth.ts";
import { bookingsCsv } from "../csv.ts";
import { buildDataExport, eraseTravellerData } from "../data-rights.ts";
import { applyDirectory, directoryWithManagers, parseDirectoryCsv } from "../directory.ts";
import { dateIn } from "../time.ts";
import { fail, handler, ISO_DATE, ISO_MONTH, parseBody, type ServerContext } from "./http.ts";

const DUTY_TIME_ZONE = "Asia/Kolkata";
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 1000;
const CURRENCY = /^[A-Z]{3}$/;

const moneySchema = z.object({
  minor: z.number().int().min(0),
  currency: z.string().regex(CURRENCY, "must be an ISO 4217 code"),
});

const policyBody = z.object({
  entityId: z.string().trim().min(1).optional(),
  caps: z
    .array(z.object({ cityTier: z.string().trim().min(1), city: z.string().trim().min(1).nullable(), perNight: moneySchema }))
    .min(1, "a policy needs at least one nightly cap"),
  requireFlexible: z.boolean(),
  blockedCountries: z.array(z.string().trim().length(2, "use ISO 3166-1 alpha-2")),
  blockedSuppliers: z.array(z.string().trim().min(1)),
  costCentres: z.array(z.string().trim().min(1)).min(1, "at least one cost centre is required"),
  defaultCostCentre: z.string().trim().min(1),
  incidentalsBufferMinor: z.number().int().min(0),
  reportingCurrency: z.string().regex(CURRENCY).optional(),
  approval: z
    .object({
      mode: z.literal("hard"),
      slaMinutes: z.number().int().min(5).max(10_080),
      maxEscalations: z.number().int().min(0).max(5),
      justificationReasons: z
        .array(z.object({ code: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(120) }))
        .min(1, "offer at least one justification reason"),
      fallbackApproverEmails: z.array(z.string().trim().email()),
    })
    .optional(),
  advisories: z
    .array(
      z.object({
        countryCode: z.string().trim().length(2),
        city: z.string().trim().min(1).nullable(),
        level: z.enum(["caution", "high"]),
        note: z.string().trim().min(1).max(500),
        updatedAt: z.string().optional(),
      }),
    )
    .optional(),
});

const entityBody = z.object({
  legalName: z.string().trim().min(2).max(200),
  gstin: z.string().trim().toUpperCase().nullable(),
  stateCode: z.string().trim().regex(/^\d{2}$/, "a two-digit GST state code").nullable(),
  address: z.string().trim().min(5).max(500),
  settlementCurrency: z.string().regex(CURRENCY),
  reportingCurrency: z.string().regex(CURRENCY),
  invoiceSeriesPrefix: z.string().trim().regex(/^[A-Z0-9]{1,6}$/, "1–6 capital letters or digits"),
});

const fxBody = z.object({
  month: z.string().regex(ISO_MONTH, "must be YYYY-MM"),
  rates: z
    .array(
      z.object({
        base: z.string().regex(CURRENCY),
        quote: z.string().regex(CURRENCY),
        rateMicros: z.number().int().positive(),
      }),
    )
    .min(1),
});

const directoryBody = z
  .object({
    entries: z
      .array(
        z.object({
          email: z.string().trim().email(),
          name: z.string().trim().min(1).max(120),
          managerEmail: z.string().trim().email().nullable(),
          costCentre: z.string().trim().min(1).nullable(),
          isAdmin: z.boolean(),
        }),
      )
      .optional(),
    csv: z.string().max(500_000).optional(),
  })
  .refine((b) => b.entries !== undefined || b.csv !== undefined, "send entries or csv");

const eraseBody = z.object({ confirmEmail: z.string().trim().min(3) });

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000;
}

/** A traveller in the admin's own entity, answering 404 itself. */
async function entityTraveller(ctx: ServerContext, req: Request, res: Response): Promise<Traveller | null> {
  const admin = req.traveller;
  if (admin === undefined) return null;
  const traveller = await ctx.store.getTraveller(req.params.travellerId ?? "");
  if (traveller === null || traveller.entityId !== admin.entityId) {
    fail(res, 404, "not_found", "That traveller does not exist.");
    return null;
  }
  return traveller;
}

export function adminRoutes(ctx: ServerContext): Router {
  const router = Router();

  // ---------- policy ----------

  router.get(
    "/admin/policy",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      res.status(200).json({ policy: await ctx.policyFor(admin.entityId) });
    }),
  );

  router.put(
    "/admin/policy",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const body = parseBody(policyBody, req, res, "invalid_policy");
      if (body === null) return;
      if (!body.costCentres.includes(body.defaultCostCentre)) {
        fail(res, 400, "invalid_policy", "defaultCostCentre must be one of the listed cost centres.");
        return;
      }

      const entityId = body.entityId ?? admin.entityId;
      const current = await ctx.policyFor(entityId);
      const now = ctx.now().toISOString();
      const next: Policy = {
        version: current.version + 1,
        entityId,
        caps: body.caps,
        requireFlexible: body.requireFlexible,
        blockedCountries: body.blockedCountries.map((c) => c.toUpperCase()),
        blockedSuppliers: body.blockedSuppliers,
        costCentres: body.costCentres,
        defaultCostCentre: body.defaultCostCentre,
        incidentalsBufferMinor: body.incidentalsBufferMinor,
        reportingCurrency: body.reportingCurrency ?? current.reportingCurrency,
        approval: body.approval ?? current.approval,
        advisories:
          body.advisories?.map((a) => ({
            countryCode: a.countryCode.toUpperCase(),
            city: a.city,
            level: a.level,
            note: a.note,
            updatedAt: a.updatedAt ?? now,
          })) ?? current.advisories,
        updatedAt: now,
        updatedBy: admin.email,
      };
      await ctx.store.savePolicy(next);
      res.status(200).json({ policy: next });
    }),
  );

  // ---------- legal entity ----------

  router.get(
    "/admin/entity",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      res.status(200).json({ entity: await ctx.entityFor(admin.entityId) });
    }),
  );

  router.put(
    "/admin/entity",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const body = parseBody(entityBody, req, res);
      if (body === null) return;
      if (body.gstin !== null && !isValidGstin(body.gstin)) {
        fail(res, 400, "invalid_gstin", "That GSTIN fails its check digit. Check it against the registration certificate.");
        return;
      }
      const entity = { id: admin.entityId, ...body };
      await ctx.store.putEntity(entity);
      res.status(200).json({ entity });
    }),
  );

  // ---------- FX pins ----------

  router.get(
    "/admin/fx-pins",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const raw = req.query.month;
      const month = typeof raw === "string" && ISO_MONTH.test(raw) ? raw : pinMonthOf(ctx.now());
      res.status(200).json({ month, rates: await ctx.store.getFxPins(month) });
    }),
  );

  router.put(
    "/admin/fx-pins",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const body = parseBody(fxBody, req, res);
      if (body === null) return;
      const asOf = ctx.now().toISOString();
      const rates: FxRate[] = body.rates.map((r) => ({
        base: r.base,
        quote: r.quote,
        rateMicros: r.rateMicros,
        source: "pinned_monthly",
        pinMonth: body.month,
        asOf,
      }));
      await ctx.store.putFxPins(body.month, rates);
      res.status(200).json({ month: body.month, rates });
    }),
  );

  // ---------- directory ----------

  router.get(
    "/admin/directory",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      res.status(200).json({ travellers: await directoryWithManagers(ctx.store, admin.entityId) });
    }),
  );

  router.post(
    "/admin/directory",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const body = parseBody(directoryBody, req, res, "invalid_directory");
      if (body === null) return;
      let entries = body.entries ?? [];
      if (body.csv !== undefined) {
        const parsed = parseDirectoryCsv(body.csv);
        if ("error" in parsed) {
          fail(res, 400, "invalid_directory", parsed.error);
          return;
        }
        entries = parsed.entries;
      }
      const result = await applyDirectory(ctx.store, {
        entityId: admin.entityId,
        entries,
        policy: await ctx.policyFor(admin.entityId),
        actingAdminId: admin.id,
        now: ctx.now(),
      });
      res.status(200).json(result);
    }),
  );

  // ---------- exceptions ----------

  router.get(
    "/admin/approvals",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const raw = req.query.state;
      const states = ["pending", "approved", "rejected", "withdrawn"];
      if (raw !== undefined && (typeof raw !== "string" || !states.includes(raw))) {
        fail(res, 400, "invalid_request", `state must be one of ${states.join(", ")}.`);
        return;
      }
      const approvals = await listApprovalViews(
        ctx,
        admin.entityId,
        typeof raw === "string" ? { state: raw as ApprovalRequest["state"] } : {},
      );
      res.status(200).json({ approvals });
    }),
  );

  // ---------- duty of care ----------

  router.get(
    "/admin/in-market",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const raw = req.query.date;
      if (raw !== undefined && (typeof raw !== "string" || !ISO_DATE.test(raw))) {
        fail(res, 400, "invalid_request", "date must be YYYY-MM-DD.");
        return;
      }
      const date = typeof raw === "string" ? raw : dateIn(ctx.now(), DUTY_TIME_ZONE);
      const [bookings, travellers, policy] = await Promise.all([
        ctx.store.listBookingsForEntity(admin.entityId),
        ctx.store.listTravellers(admin.entityId),
        ctx.policyFor(admin.entityId),
      ]);
      const rows = travellersInMarket({ date, bookings, travellers, policy });
      res.status(200).json({ date, travellers: rows, byCountry: summariseByCountry(rows) });
    }),
  );

  // ---------- data rights ----------

  router.get(
    "/admin/travellers/:travellerId/export",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const traveller = await entityTraveller(ctx, req, res);
      if (traveller === null) return;
      res.status(200).json(await buildDataExport(ctx.store, traveller, ctx.now()));
    }),
  );

  router.post(
    "/admin/travellers/:travellerId/erase",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const traveller = await entityTraveller(ctx, req, res);
      if (traveller === null) return;
      const body = parseBody(eraseBody, req, res);
      if (body === null) return;
      if (traveller.erasedAt !== null) {
        fail(res, 409, "already_erased", "This traveller was already erased.");
        return;
      }
      if (normaliseEmail(body.confirmEmail) !== normaliseEmail(traveller.email)) {
        fail(res, 422, "confirmation_mismatch", "Type the traveller's email exactly to confirm erasure.");
        return;
      }
      res.status(200).json(await eraseTravellerData(ctx.store, traveller, ctx.now()));
    }),
  );

  // ---------- metrics ----------

  router.get(
    "/admin/metrics",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const [bookings, approvals, cardEvents] = await Promise.all([
        ctx.store.listBookingsForEntity(admin.entityId),
        ctx.store.listApprovals(admin.entityId),
        ctx.store.listCardEvents(admin.entityId),
      ]);
      const confirmed = bookings.filter((b) => b.state === "confirmed" || b.state === "settled" || b.state === "modified");
      const decided = approvals.filter((a) => a.decidedAt !== null);
      const withinSla = decided.filter((a) => {
        const first = a.levels[0];
        return first !== undefined && a.decidedAt !== null && a.decidedAt <= first.dueAt;
      });
      const approved = approvals.filter((a) => a.state === "approved");
      const issued = cardEvents.filter((e) => e.kind === "issued").length;
      const issueDeclined = cardEvents.filter((e) => e.kind === "issue_declined").length;
      const deskDeclined = cardEvents.filter((e) => e.kind === "desk_declined").length;
      res.status(200).json({
        bookings: bookings.length,
        confirmed: confirmed.length,
        inPolicyRate: ratio(confirmed.filter((b) => b.verdict.state === "in").length, confirmed.length),
        approvals: {
          total: approvals.length,
          pending: approvals.filter((a) => a.state === "pending").length,
          withinSlaRate: ratio(withinSla.length, decided.length),
          rateLostRate: ratio(approved.filter((a) => a.outcome === "rate_lost").length, approved.length),
        },
        cards: {
          issued,
          issueDeclined,
          deskDeclined,
          declineRate: ratio(issueDeclined + deskDeclined, issued + issueDeclined),
        },
        invoices: bookings.filter((b) => b.invoiceId !== null).length,
      });
    }),
  );

  // ---------- reporting (Slice 1, extended) ----------

  router.get(
    "/admin/bookings.csv",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      const [bookings, travellers, approvals] = await Promise.all([
        ctx.store.listBookingsForEntity(admin.entityId),
        ctx.store.listTravellers(admin.entityId),
        ctx.store.listApprovals(admin.entityId),
      ]);
      const invoices = await Promise.all(
        bookings.filter((b) => b.invoiceId !== null).map((b) => ctx.store.getInvoiceForBooking(b.id)),
      );
      const emails = new Map<string, string>(travellers.map((t) => [t.id, t.email]));
      const approvalById = new Map<string, ApprovalRequest>(approvals.map((a) => [a.id, a]));
      const invoiceByBooking = new Map<string, Invoice>(
        invoices.filter((i): i is Invoice => i !== null).map((i) => [i.bookingId, i]),
      );
      res
        .status(200)
        .type("text/csv; charset=utf-8")
        .setHeader("Content-Disposition", 'attachment; filename="bookings.csv"');
      res.send(
        bookingsCsv(bookings, (id) => emails.get(id) ?? "", {
          approvalFor: (id) => approvalById.get(id),
          invoiceFor: (id) => invoiceByBooking.get(id),
        }),
      );
    }),
  );

  router.get(
    "/admin/bookings",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const admin = req.traveller;
      if (admin === undefined) return;
      res.status(200).json({ bookings: await ctx.store.listBookingsForEntity(admin.entityId) });
    }),
  );

  router.get(
    "/admin/source-log",
    ctx.auth.requireAdmin,
    handler(async (req, res) => {
      const raw = req.query.limit;
      const asNumber = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
      const limit = Number.isFinite(asNumber) ? Math.min(Math.max(asNumber, 1), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
      res.status(200).json({ entries: await ctx.store.listSourceLog(limit) });
    }),
  );

  return router;
}
