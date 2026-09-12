/**
 * The identity seam. Slice 1 ships a dev SSO stub in place of OIDC (§2.9 makes
 * SAML/OIDC + SCIM mandatory for v1 proper); everything above this file reads
 * `req.traveller` and never learns how the session was established, so swapping
 * in a real IdP touches only this module.
 *
 * Session transport is a signed cookie, `sm_session`. The cookie carries a
 * traveller id and an issued-at, and an HMAC-SHA256 tag over both — so it is a
 * bearer of identity, never of authorisation: admin-ness is re-read from the
 * store on every request and cannot be forged by editing the cookie.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";

import type { Traveller } from "../core/types.ts";
import type { Store } from "../store/Store.ts";

export const SESSION_COOKIE = "sm_session";

/**
 * Slice 1 runs one legal entity. The type everywhere is already multi-entity
 * (§2.9, A17), so this is the only place the single-tenant assumption lives.
 */
export const DEFAULT_ENTITY_ID = "acme";

const FALLBACK_COST_CENTRE = "ENG-OPS";

/** Dev default is deliberately obvious; production must set SM_SECRET. */
const DEV_SECRET = "strict-mode-dev-secret-do-not-use-in-production";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traveller?: Traveller;
    }
  }
}

export interface Auth {
  /** JIT-creates the traveller on first sight and sets the session cookie. */
  login(res: Response, email: string, name?: string): Promise<Traveller>;
  logout(res: Response): void;
  /** Populates `req.traveller` when the cookie is valid. Never rejects. */
  middleware: RequestHandler;
  /** 401 when unauthenticated. */
  requireAuth: RequestHandler;
  /** 401 when unauthenticated, 403 when not an admin. */
  requireAdmin: RequestHandler;
}

interface SessionPayload {
  readonly tid: string;
  readonly iat: number;
}

/**
 * Session-signing key. In production an unset SM_SECRET is fatal, not a fallback:
 * the dev secret is in the source, so falling back to it on a public deployment
 * would let anyone forge a session cookie for any traveller — including the admin.
 * Failing to boot is the only safe behaviour.
 */
function secret(): string {
  const fromEnv = process.env.SM_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SM_SECRET must be set in production — refusing to sign sessions with the public dev secret",
    );
  }
  return DEV_SECRET;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  const expected = sign(body);
  if (tag.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(tag), Buffer.from(expected))) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { tid, iat } = parsed as { tid?: unknown; iat?: unknown };
    if (typeof tid !== "string" || typeof iat !== "number") return null;
    return { tid, iat };
  } catch {
    return null;
  }
}

/** Minimal cookie-header parse — `cookie-parser` is not a dependency. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

function unauthenticated(res: Response): void {
  res.status(401).json({
    error: {
      code: "unauthenticated",
      message: "Sign in to continue.",
    },
  });
}

export function createAuth(store: Store, now: () => Date = () => new Date()): Auth {
  // Resolve the secret eagerly, at construction. Called lazily it only throws on
  // the first sign-in, so a misconfigured production deploy boots, passes its
  // health check, goes live, and fails on the first real traveller. A refusal has
  // to happen before the process is reachable.
  secret();

  async function jitTraveller(email: string, name: string | undefined): Promise<Traveller> {
    const existing = await store.getTravellerByEmail(email);
    if (existing !== null) return existing;

    // The first traveller ever created owns policy: a fresh install must have
    // someone who can reach /admin without a seeding script.
    const isAdmin = (await store.listTravellers()).length === 0;
    const fallbackName = email.split("@")[0] ?? email;
    const policy = await store.getCurrentPolicy(DEFAULT_ENTITY_ID);
    const created: Traveller = {
      id: `trv_${randomUUID()}`,
      email: email.trim(),
      name: name !== undefined && name.trim() !== "" ? name.trim() : fallbackName,
      entityId: DEFAULT_ENTITY_ID,
      defaultCostCentre: policy?.defaultCostCentre ?? FALLBACK_COST_CENTRE,
      isAdmin,
      createdAt: now().toISOString(),
    };
    await store.putTraveller(created);
    return created;
  }

  return {
    async login(res, email, name) {
      const traveller = await jitTraveller(email, name);
      // Session lifetime runs on the wall clock, never on the injected business
      // clock: `now` exists so tests (and an audit) can reason about decisions
      // like the cancellation window, and stepping it forward a day must not log
      // the traveller out mid-journey.
      res.cookie(SESSION_COOKIE, encode({ tid: traveller.id, iat: Date.now() }), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_MS,
        secure: process.env.NODE_ENV === "production",
      });
      return traveller;
    },

    logout(res) {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
    },

    middleware(req, _res, next) {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (token === null) {
        next();
        return;
      }
      const payload = decode(token);
      if (payload === null || Date.now() - payload.iat > SESSION_MAX_AGE_MS) {
        next();
        return;
      }
      store
        .getTraveller(payload.tid)
        .then((traveller) => {
          if (traveller !== null) req.traveller = traveller;
          next();
        })
        .catch(next);
    },

    requireAuth(req, res, next) {
      if (req.traveller === undefined) {
        unauthenticated(res);
        return;
      }
      next();
    },

    requireAdmin(req, res, next) {
      if (req.traveller === undefined) {
        unauthenticated(res);
        return;
      }
      if (!req.traveller.isAdmin) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This page is for travel administrators.",
          },
        });
        return;
      }
      next();
    },
  };
}
