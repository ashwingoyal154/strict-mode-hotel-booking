/**
 * One secret, several signed artefacts: the session cookie, self-describing
 * search ids and one-tap approval tokens. Each artefact signs under its own
 * *purpose*, so a valid search id can never be replayed as an approval token
 * even though both are HMACs under `SM_SECRET`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Dev default is deliberately obvious; production must set SM_SECRET. */
const DEV_SECRET = "strict-mode-dev-secret-do-not-use-in-production";

/**
 * In production an unset SM_SECRET is fatal, not a fallback: the dev secret is in
 * the source, so falling back to it on a public deployment would let anyone forge
 * a session, a search id or an approval link. Failing to boot is the only safe
 * behaviour.
 */
export function serverSecret(): string {
  const fromEnv = process.env.SM_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SM_SECRET must be set in production — refusing to sign sessions with the public dev secret",
    );
  }
  return DEV_SECRET;
}

export function hmac(purpose: string, data: string): string {
  return createHmac("sha256", serverSecret()).update(`${purpose}\n${data}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `base64url(JSON).tag` */
export function sealJson(purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(purpose, body)}`;
}

/** The payload, or null when the token is malformed or its tag does not verify. */
export function openJson(purpose: string, token: string): unknown {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  if (!safeEqual(tag, hmac(purpose, body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
