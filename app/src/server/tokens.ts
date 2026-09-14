/**
 * One-tap approval links. A token is HMAC-signed over the approval id, the
 * approver id, the decision and an expiry 72 hours out, and it is single-use:
 * consumption goes through `store.consumeActionToken`, which is atomic across
 * instances. Verifying a token has no side effects; only the decision POST
 * consumes it.
 */

import { randomUUID } from "node:crypto";

import { openJson, sealJson } from "./signing.ts";

export const ACTION_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const PURPOSE = "approval-action";

export type Decision = "approve" | "reject";

export interface ActionTokenClaims {
  readonly tokenId: string;
  readonly approvalId: string;
  readonly approverId: string;
  readonly decision: Decision;
  readonly expiresAt: number;
}

interface Wire {
  readonly k: string;
  readonly a: string;
  readonly p: string;
  readonly d: Decision;
  readonly e: number;
}

export function issueActionToken(args: {
  approvalId: string;
  approverId: string;
  decision: Decision;
  now: Date;
}): string {
  const wire: Wire = {
    k: randomUUID(),
    a: args.approvalId,
    p: args.approverId,
    d: args.decision,
    e: args.now.getTime() + ACTION_TOKEN_TTL_MS,
  };
  return sealJson(PURPOSE, wire);
}

export function verifyActionToken(
  token: string,
  now: Date,
): { ok: true; claims: ActionTokenClaims } | { ok: false; reason: string } {
  const raw = openJson(PURPOSE, token) as Partial<Wire> | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof raw.k !== "string" ||
    typeof raw.a !== "string" ||
    typeof raw.p !== "string" ||
    (raw.d !== "approve" && raw.d !== "reject") ||
    typeof raw.e !== "number"
  ) {
    return { ok: false, reason: "This link is not valid. Open the request from your approvals inbox." };
  }
  if (now.getTime() >= raw.e) {
    return { ok: false, reason: "This link has expired. Open the request from your approvals inbox." };
  }
  return {
    ok: true,
    claims: { tokenId: raw.k, approvalId: raw.a, approverId: raw.p, decision: raw.d, expiresAt: raw.e },
  };
}

export function actionUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/a/${token}`;
}
