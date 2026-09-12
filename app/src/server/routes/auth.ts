/**
 * Auth routes — the dev SSO stand-in. `POST /api/auth/login` is where OIDC lands
 * in slice 2; the rest of the app already reads identity from the session only.
 */

import { Router } from "express";
import { z } from "zod";

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
      const traveller = await ctx.auth.login(res, body.email, body.name);
      res.status(200).json({ traveller });
    }),
  );

  router.post("/auth/logout", (_req, res) => {
    ctx.auth.logout(res);
    res.status(204).end();
  });

  router.get("/me", (req, res) => {
    if (req.traveller === undefined) {
      fail(res, 401, "unauthenticated", "Sign in to continue.");
      return;
    }
    res.status(200).json({ traveller: req.traveller });
  });

  return router;
}
