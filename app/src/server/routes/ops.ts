/**
 * Ops endpoints. Deliberately unauthenticated and deliberately cheap: a health
 * probe that calls supply would make a supplier outage look like an app outage,
 * which is the opposite of §3.3's "a source outage degrades, never errors".
 */

import { Router } from "express";

import { DEFAULT_ENTITY_ID } from "../auth.ts";
import { handler, type ServerContext } from "./http.ts";

export const APP_VERSION = process.env.SM_VERSION ?? "1.0.0";
export const SLICE = 1;

export function opsRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      sources: ctx.sources.map((s) => ({ id: s.id, ok: true })),
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
      });
    }),
  );

  return router;
}
