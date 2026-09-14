/**
 * Helpers shared by the three DocPersistence adapters. Nothing here does I/O.
 *
 * Naming rules are enforced identically on every backend, so a name that works
 * against memory in a test cannot fail against Blob in production.
 */

import { createHash } from "node:crypto";

/**
 * Collections and streams: lowercase, no slash. Lowercase because the file
 * adapter may sit on a case-insensitive filesystem (macOS); no slash so that
 * listing `a/` can never pick up the documents of a collection named `a/b`.
 * A leading underscore is reserved: `_stream` holds the append-only streams and
 * must not be reachable through `put`/`replace`/`delete`.
 */
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const STREAM_ROOT = "_stream";

export function assertCollection(name: string): void {
  if (!NAME.test(name)) throw new RangeError(`invalid collection name ${JSON.stringify(name)}`);
}

export function assertStream(name: string): void {
  if (!NAME.test(name)) throw new RangeError(`invalid stream name ${JSON.stringify(name)}`);
}

export function assertId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 512) {
    throw new RangeError("document id must be 1-512 characters");
  }
  try {
    // Lone surrogates cannot be percent-encoded, so they cannot be a pathname.
    encodeURIComponent(id);
  } catch {
    throw new RangeError("document id is not well-formed UTF-16");
  }
}

export class StreamEntryExistsError extends Error {
  constructor(readonly stream: string, readonly id: string) {
    super(`stream ${stream} already has an entry ${id}; streams are append-only`);
    this.name = "StreamEntryExistsError";
  }
}

/** Code-unit order: the same on every backend and for every locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normaliseLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : limit === Infinity ? Number.MAX_SAFE_INTEGER : 0;
}

/** Picks `limit` ids from an ascending list, from the requested end. */
export function pickStreamIds(sortedAsc: readonly string[], limit: number, newestFirst: boolean): string[] {
  const n = normaliseLimit(limit);
  if (n === 0) return [];
  return newestFirst ? sortedAsc.slice(-n).reverse() : sortedAsc.slice(0, n);
}

export function serialise(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new TypeError("document is not JSON-serialisable");
  return text;
}

/**
 * JSON with object keys sorted, for exact structural comparison. Unlike a short
 * hash it cannot collide, and a collision there would mean skipping a real write.
 */
export function canonicalJson(value: unknown): string {
  return serialise(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeys(record[k])]));
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jittered exponential backoff, so contenders that collided do not collide again in lockstep. */
export function backoffMs(attempt: number, capMs = 250): number {
  return Math.min(capMs, 5 * 2 ** Math.min(attempt, 10)) * (0.5 + Math.random());
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * A per-key async mutex. Callers on the same key run strictly one after another;
 * different keys run in parallel.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<R>(key: string, fn: () => Promise<R> | R): Promise<R> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => current);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
