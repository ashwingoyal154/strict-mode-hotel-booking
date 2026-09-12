/**
 * Shared route plumbing: the error envelope, async-handler wrapping and body
 * validation. One envelope, defined once, because the `code` strings in
 * API_CONTRACT.md are a machine contract the web client switches on.
 */

import type { Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import type { Policy } from "../../core/types.ts";
import type { CardIssuer } from "../../payments/CardIssuer.ts";
import type { RouteSource } from "../../routing/RouteSource.ts";
import type { RateSource } from "../../supply/RateSource.ts";
import type { Store } from "../../store/Store.ts";
import type { Auth } from "../auth.ts";
import type { SearchRegistry } from "../search.ts";

export interface ServerContext {
  readonly store: Store;
  /** Already wrapped by `audit.ts` — routes never see a raw source. */
  readonly sources: RateSource[];
  readonly routes: RouteSource;
  readonly issuer: CardIssuer;
  readonly now: () => Date;
  readonly searches: SearchRegistry;
  readonly auth: Auth;
  readonly policyFor: (entityId: string) => Promise<Policy>;
}

export function fail(
  res: Response,
  status: number,
  code: string,
  message: string,
  detail?: unknown,
): void {
  const error: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) error.detail = detail;
  res.status(status).json({ error });
}

/** Express 4 does not catch rejected promises; every handler goes through here. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Validates a body and writes a 400 with a readable message on failure.
 * Returns null when it has already answered the request.
 */
export function parseBody<T>(schema: ZodType<T>, req: Request, res: Response): T | null {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? "body" : first.path.join(".");
  const why = first === undefined ? "is invalid" : first.message;
  fail(res, 400, "invalid_request", `${where}: ${why}`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
  return null;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
