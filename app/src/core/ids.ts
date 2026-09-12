/**
 * Identifier minting and fingerprinting.
 *
 * Randomness is an injected parameter, not an ambient capability: a booking id
 * appears in an immutable audit record, and a test that cannot reproduce one
 * cannot assert on it. Callers in production pass nothing and get Math.random.
 */

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_BODY_LENGTH = 16;

/** A-Z and 2-9 minus I, O, 0, 1 — the pairs a human reads aloud wrongly over the phone. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/** Maps a [0,1) draw onto an alphabet index, clamped so a sloppy rand() cannot escape it. */
function pick(alphabet: string, r: number): string {
  const raw = Math.floor(r * alphabet.length);
  const index = Math.min(alphabet.length - 1, Math.max(0, Number.isFinite(raw) ? raw : 0));
  return alphabet.charAt(index);
}

/** A prefixed opaque id, e.g. `bkg_8f2k...`; deterministic when `rand` is supplied. */
export function newId(prefix: string, rand: () => number = Math.random): string {
  if (prefix.length === 0) throw new RangeError("newId requires a non-empty prefix");
  let body = "";
  for (let i = 0; i < ID_BODY_LENGTH; i++) body += pick(ID_ALPHABET, rand());
  return `${prefix}_${body}`;
}

/** A 6-character confirmation code from an unambiguous alphabet (no I, O, 0 or 1). */
export function newConfirmationCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += pick(CODE_ALPHABET, rand());
  return code;
}

/** True for 8–200 visible-ASCII characters; A14 depends on keys being comparable verbatim. */
export function isValidIdempotencyKey(k: string): boolean {
  if (typeof k !== "string") return false;
  if (k.length < 8 || k.length > 200) return false;
  for (let i = 0; i < k.length; i++) {
    const code = k.charCodeAt(i);
    // 0x21..0x7E: printable, no control characters and no whitespace to be
    // trimmed differently by a proxy and turn one request into two bookings.
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Canonical serialisation: object keys sorted, so `{a,b}` and `{b,a}` produce
 * one string. Array order is preserved — that is data, not layout.
 */
function canonicalise(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value === true ? "true" : "false";
  if (t === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new TypeError(`stableHash cannot hash a ${t}`);
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalise(item))).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = record[key];
    // Skip undefined members so `{a:1}` and `{a:1,b:undefined}` fingerprint alike,
    // matching what JSON round-tripping through storage would have done anyway.
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalise(child)}`);
  }
  return `{${parts.join(",")}}`;
}

/** 32-bit FNV-1a over a string, with a caller-chosen offset basis. */
function fnv1a(input: string, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A stable 16-hex-character fingerprint of any JSON-shaped value, independent of
 * object key order — two independent 32-bit passes, so an idempotency
 * fingerprint does not collide on a 32-bit birthday.
 */
export function stableHash(value: unknown): string {
  const canonical = canonicalise(value);
  const a = fnv1a(canonical, 0x811c9dc5);
  const b = fnv1a(canonical, 0x7fffffff);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
