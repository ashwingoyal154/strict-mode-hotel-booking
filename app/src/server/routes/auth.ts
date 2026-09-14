/**
 * Identity routes — the dev SSO stand-in, the demo cast, and the caller's own
 * record. `POST /api/auth/login` is where OIDC lands; the rest of the app already
 * reads identity from the session only.
 */

import { Router } from "express";
import { z } from "zod";

import { countDecidable } from "../approvals.ts";
import { AccountErasedError } from "../auth.ts";
import { buildDataExport } from "../data-rights.ts";
import { DEMO_PERSONAS } from "../seed.ts";
import { fail, handler, parseBody, type ServerContext } from "./http.ts";

const loginBody = z.object({
  email: z.string().trim().min(3).email("must be a work email address"),
  name: z.string().trim().min(1).max(120).optional(),
});

export function authRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.post(
    "/auth/login",
    handler(async (req, res) => {
      const body = parseBody(loginBody, req, res);
      if (body === null) return;
      try {
        const traveller = await ctx.auth.login(res, body.email, body.name);
        res.status(200).json({ traveller });
      } catch (err) {
        if (err instanceof AccountErasedError) {
          fail(res, 403, "account_erased", err.message);
          return;
        }
        throw err;
      }
    }),
  );

  router.post("/auth/logout", (_req, res) => {
    ctx.auth.logout(res);
    res.status(204).end();
  });

  router.get("/auth/demo-personas", (_req, res) => {
    res.status(200).json({ enabled: ctx.demo, personas: ctx.demo ? DEMO_PERSONAS : [] });
  });

  router.get(
    "/me",
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) {
        fail(res, 401, "unauthenticated", "Sign in to continue.");
        return;
      }
      const [entity, approvalsPending] = await Promise.all([
        ctx.entityFor(traveller.entityId),
        countDecidable(ctx, traveller),
      ]);
      res.status(200).json({ traveller, entity, approvalsPending, demo: ctx.demo });
    }),
  );

  router.get(
    "/me/export",
    ctx.auth.requireAuth,
    handler(async (req, res) => {
      const traveller = req.traveller;
      if (traveller === undefined) return;
      res.status(200).json(await buildDataExport(ctx.store, traveller, ctx.now()));
    }),
  );

  return router;
}
