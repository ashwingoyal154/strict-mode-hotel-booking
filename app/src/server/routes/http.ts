/**
 * Shared route plumbing: the server context, the error envelope, async-handler
 * wrapping and body validation. One envelope, defined once, because the `code`
 * strings in API_CONTRACT.md are a machine contract the web client switches on.
 */

import type { Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import type { LegalEntity, Policy } from "../../core/types.ts";
import type { Auth } from "../auth.ts";
import type { AppDeps } from "../deps.ts";
import type { SearchRegistry } from "../search.ts";

/**
 * AppDeps with the outbound ports already wrapped by `audit.ts` — routes never see
 * a raw source, issuer or notifier — plus the per-instance services.
 */
export interface ServerContext extends AppDeps {
  readonly searches: SearchRegistry;
  readonly auth: Auth;
  readonly policyFor: (entityId: string) => Promise<Policy>;
  readonly entityFor: (entityId: string) => Promise<LegalEntity>;
  /** "memory" | "file" | "blob" | "custom", for /api/version. */
  readonly storeKind: string;
}

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export function errorResult(status: number, code: string, message: string, detail?: unknown): HttpResult {
  const error: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) error.detail = detail;
  return { status, body: { error } };
}

export function ok(status: number, body: unknown): HttpResult {
  return { status, body };
}

export function send(res: Response, result: HttpResult): void {
  res.status(result.status).json(result.body);
}

export function fail(res: Response, status: number, code: string, message: string, detail?: unknown): void {
  send(res, errorResult(status, code, message, detail));
}

/** Express 4 does not catch rejected promises; every handler goes through here. */
export function handler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Validates a body and writes a 400 on failure. Returns null when it has already answered. */
export function parseBody<T>(schema: ZodType<T>, req: Request, res: Response, code = "invalid_request"): T | null {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? "body" : first.path.join(".");
  const why = first === undefined ? "is invalid" : first.message;
  fail(res, 400, code, `${where}: ${why}`, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
  return null;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
