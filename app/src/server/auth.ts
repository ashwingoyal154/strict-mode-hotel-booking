/**
 * The identity seam. A dev SSO stub stands in for OIDC; everything above this
 * file reads `req.traveller` and never learns how the session was established.
 *
 * Session transport is a signed cookie, `sm_session`, carrying a traveller id and
 * an issued-at under an HMAC — a bearer of identity, never of authorisation:
 * admin-ness is re-read from the store on every request. An erased traveller's
 * session stops resolving the moment the erasure is written.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";

import type { Traveller } from "../core/types.ts";
import type { Store } from "../store/Store.ts";
import { safeEqual, serverSecret } from "./signing.ts";

export const SESSION_COOKIE = "sm_session";

/** One legal entity per tenant in Slice 2; the only place that assumption lives. */
export const DEFAULT_ENTITY_ID = "acme";

const FALLBACK_COST_CENTRE = "ENG-OPS";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traveller?: Traveller;
    }
  }
}

export class AccountErasedError extends Error {
  constructor() {
    super("This account was erased under a data-rights request.");
    this.name = "AccountErasedError";
  }
}

export interface Auth {
  /** JIT-creates the traveller on first sight and sets the session cookie. */
  login(res: Response, email: string, name?: string): Promise<Traveller>;
  logout(res: Response): void;
  /** Populates `req.traveller` when the cookie is valid. Never rejects. */
  middleware: RequestHandler;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
}

interface SessionPayload {
  readonly tid: string;
  readonly iat: number;
}

function sign(data: string): string {
  return createHmac("sha256", serverSecret()).update(data).digest("base64url");
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(body))) return null;
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

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function unauthenticated(res: Response): void {
  res.status(401).json({ error: { code: "unauthenticated", message: "Sign in to continue." } });
}

export function createAuth(store: Store, now: () => Date = () => new Date()): Auth {
  // Resolved eagerly: a misconfigured production deploy must refuse to boot, not
  // pass its health check and fail on the first real traveller.
  serverSecret();

  async function jitTraveller(rawEmail: string, name: string | undefined): Promise<Traveller> {
    const email = normaliseEmail(rawEmail);
    const existing = await store.getTravellerByEmail(email);
    if (existing !== null) {
      if (existing.erasedAt !== null) throw new AccountErasedError();
      return existing;
    }

    // The first traveller ever created owns policy: a fresh install must have
    // someone who can reach /admin without a seeding script.
    const isAdmin = (await store.listTravellers(DEFAULT_ENTITY_ID)).length === 0;
    const fallbackName = email.split("@")[0] ?? email;
    const policy = await store.getCurrentPolicy(DEFAULT_ENTITY_ID);
    const created: Traveller = {
      id: `trv_${randomUUID()}`,
      email,
      name: name !== undefined && name.trim() !== "" ? name.trim() : fallbackName,
      entityId: DEFAULT_ENTITY_ID,
      defaultCostCentre: policy?.defaultCostCentre ?? FALLBACK_COST_CENTRE,
      isAdmin,
      createdAt: now().toISOString(),
      managerId: null,
      displayCurrency: null,
      erasedAt: null,
    };
    await store.putTraveller(created);
    return created;
  }

  return {
    async login(res, email, name) {
      const traveller = await jitTraveller(email, name);
      // Session lifetime runs on the wall clock, never on the injected business
      // clock, so stepping `now` forward in a test does not log anyone out.
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
          if (traveller !== null && traveller.erasedAt === null) req.traveller = traveller;
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
          error: { code: "forbidden", message: "This page is for travel administrators." },
        });
        return;
      }
      next();
    },
  };
}
