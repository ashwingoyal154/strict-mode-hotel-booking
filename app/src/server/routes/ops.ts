/**
 * Ops endpoints. Deliberately unauthenticated and deliberately cheap: a health
 * probe that called supply would make a supplier outage look like an app outage,
 * the opposite of §3.3's "a source outage degrades, never errors".
 */

import { Router } from "express";

import { POLICY_EVALUATOR_VERSION } from "../../core/policy.ts";
import { DEFAULT_ENTITY_ID } from "../auth.ts";
import { handler, type ServerContext } from "./http.ts";

export const APP_VERSION = process.env.SM_VERSION ?? "2.0.0";
export const SLICE = 2;

export function opsRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      sources: ctx.sources.map((s) => ({ id: s.id, ok: true, live: s.capabilities.live })),
    });
  });

  router.get(
    "/version",
    handler(async (req, res) => {
      const entityId = req.traveller?.entityId ?? DEFAULT_ENTITY_ID;
      const policy = await ctx.store.getCurrentPolicy(entityId);
      res.status(200).json({
        version: APP_VERSION,
        slice: SLICE,
        policyVersion: policy?.version ?? 0,
        evaluatorVersion: POLICY_EVALUATOR_VERSION,
        adapters: {
          store: ctx.storeKind,
          supply: ctx.sources.map((s) => ({ id: s.id, live: s.capabilities.live })),
          issuer: { id: ctx.issuer.id, live: ctx.issuer.capabilities.live },
          notifiers: ctx.notifiers.map((n) => ({ id: n.id, channel: n.channel, live: n.live })),
          intent: ctx.intentParser.id,
        },
      });
    }),
  );

  return router;
}
