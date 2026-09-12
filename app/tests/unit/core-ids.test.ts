import {
  isValidIdempotencyKey,
  newConfirmationCode,
  newId,
  stableHash,
} from "../../src/core/ids.ts";

/** A seeded generator: ids in an audit record have to be reproducible in a test. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("newId", () => {
  it("prefixes and separates with an underscore", () => {
    expect(newId("bkg", seeded(1))).toMatch(/^bkg_[0-9a-z]{16}$/);
  });

  it("is deterministic for a given rand", () => {
    expect(newId("bkg", seeded(42))).toBe(newId("bkg", seeded(42)));
  });

  it("differs between seeds", () => {
    expect(newId("bkg", seeded(1))).not.toBe(newId("bkg", seeded(2)));
  });

  it("differs between calls on a live generator", () => {
    const rand = seeded(7);
    expect(newId("bkg", rand)).not.toBe(newId("bkg", rand));
  });

  it("uses Math.random when no generator is given", () => {
    expect(newId("trv")).toMatch(/^trv_[0-9a-z]{16}$/);
    expect(newId("trv")).not.toBe(newId("trv"));
  });

  it("rejects an empty prefix", () => {
    expect(() => newId("", seeded(1))).toThrow(RangeError);
  });

  it("stays inside its alphabet even when rand misbehaves", () => {
    expect(newId("x", () => 0)).toBe(`x_${"0".repeat(16)}`);
    expect(newId("x", () => 1)).toBe(`x_${"z".repeat(16)}`);
    expect(newId("x", () => -1)).toBe(`x_${"0".repeat(16)}`);
    expect(newId("x", () => Number.NaN)).toBe(`x_${"0".repeat(16)}`);
  });
});

describe("newConfirmationCode", () => {
  it("is six characters from the unambiguous alphabet", () => {
    expect(newConfirmationCode(seeded(3))).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("never emits I, O, 0 or 1 — they are misheard over the phone", () => {
    const rand = seeded(11);
    for (let i = 0; i < 500; i++) {
      expect(newConfirmationCode(rand)).not.toMatch(/[IO01]/);
    }
  });

  it("covers the whole alphabet across the [0,1) range without escaping it", () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < alphabet.length; i++) {
      const expected = alphabet.charAt(i);
      expect(newConfirmationCode(() => i / alphabet.length)).toBe(expected.repeat(6));
    }
  });

  it("is deterministic for a given rand", () => {
    expect(newConfirmationCode(seeded(99))).toBe(newConfirmationCode(seeded(99)));
  });

  it("clamps a rand that returns exactly 1", () => {
    expect(newConfirmationCode(() => 1)).toBe("999999");
  });
});

describe("isValidIdempotencyKey", () => {
  it("accepts a uuid", () => {
    expect(isValidIdempotencyKey("11111111-2222-3333-4444-555555555555")).toBe(true);
  });

  it("enforces the 8..200 length bounds", () => {
    expect(isValidIdempotencyKey("1234567")).toBe(false);
    expect(isValidIdempotencyKey("12345678")).toBe(true);
    expect(isValidIdempotencyKey("k".repeat(200))).toBe(true);
    expect(isValidIdempotencyKey("k".repeat(201))).toBe(false);
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("rejects whitespace and control characters a proxy might trim differently", () => {
    expect(isValidIdempotencyKey("key with spaces")).toBe(false);
    expect(isValidIdempotencyKey("key\twith\ttabs")).toBe(false);
    expect(isValidIdempotencyKey("key\nnewline")).toBe(false);
    expect(isValidIdempotencyKey("  11111111-2222  ")).toBe(false);
  });

  it("rejects non-ASCII, which does not survive every header hop intact", () => {
    expect(isValidIdempotencyKey("idempotency-kéy-1")).toBe(false);
    expect(isValidIdempotencyKey("key-₹-12345")).toBe(false);
  });

  it("accepts the punctuation keys are actually written with", () => {
    expect(isValidIdempotencyKey("bkg:2026-06-11/off_1#1")).toBe(true);
  });
});

describe("stableHash", () => {
  it("is 16 hex characters", () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores object key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it("ignores key order at every depth", () => {
    const left = { outer: { x: [1, { p: 1, q: 2 }], y: "s" }, z: true };
    const right = { z: true, outer: { y: "s", x: [1, { q: 2, p: 1 }] } };
    expect(stableHash(left)).toBe(stableHash(right));
  });

  it("respects array order, which is data rather than layout", () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });

  it("distinguishes values that merely stringify alike", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: "1" }));
    expect(stableHash({ a: null })).not.toBe(stableHash({}));
    expect(stableHash(0)).not.toBe(stableHash("0"));
    expect(stableHash(false)).not.toBe(stableHash(0));
  });

  it("treats an absent key and an undefined key alike, as storage would", () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }));
  });

  it("handles primitives, null and undefined at the top level", () => {
    for (const value of [null, undefined, 0, -1.5, "", "x", true, false]) {
      expect(stableHash(value)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(stableHash(null)).not.toBe(stableHash(undefined));
  });

  it("hashes a Date by its instant, not its local rendering", () => {
    expect(stableHash(new Date("2026-06-11T09:00:00.000Z"))).toBe(
      stableHash(new Date(Date.UTC(2026, 5, 11, 9))),
    );
    expect(stableHash(new Date("2026-06-11T09:00:00.000Z"))).toBe(
      stableHash("2026-06-11T09:00:00.000Z"),
    );
  });

  it("is stable across calls — the same booking fingerprint twice", () => {
    const payload = { searchId: "srch_1", offerId: "off_1", acceptedTotal: { minor: 3480000, currency: "INR" } };
    expect(stableHash(payload)).toBe(stableHash(payload));
  });

  it("changes when any value changes, down to one paisa", () => {
    const a = stableHash({ acceptedTotal: { minor: 3480000, currency: "INR" } });
    const b = stableHash({ acceptedTotal: { minor: 3480001, currency: "INR" } });
    expect(a).not.toBe(b);
  });

  it("refuses what it cannot canonicalise rather than colliding silently", () => {
    expect(() => stableHash(() => 1)).toThrow(TypeError);
    expect(() => stableHash(10n)).toThrow(TypeError);
    expect(() => stableHash(Symbol("s"))).toThrow(TypeError);
  });

  it("treats a non-finite number the way JSON storage would", () => {
    expect(stableHash(Number.POSITIVE_INFINITY)).toBe(stableHash(null));
  });
});
