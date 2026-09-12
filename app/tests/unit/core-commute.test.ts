import {
  describeCommute,
  estimateCommute,
  haversineMeters,
  nightsBetween,
} from "../../src/core/commute.ts";

const BKC = { lat: 19.0654, lng: 72.8686 }; // Bandra Kurla Complex, Mumbai
const WHITEFIELD = { lat: 12.9698, lng: 77.75 };
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };

/** A point `metres` due north, so a band can be targeted exactly. */
function north(metres: number): { lat: number; lng: number } {
  return { lat: BKC.lat + metres / 111320, lng: BKC.lng };
}

describe("nightsBetween", () => {
  it("counts nights, not days", () => {
    expect(nightsBetween("2026-06-11", "2026-06-15")).toBe(4);
  });

  it("is zero for a same-day range", () => {
    expect(nightsBetween("2026-06-11", "2026-06-11")).toBe(0);
  });

  it("counts a single night", () => {
    expect(nightsBetween("2026-06-11", "2026-06-12")).toBe(1);
  });

  it("crosses months and years without drifting", () => {
    expect(nightsBetween("2026-06-29", "2026-07-02")).toBe(3);
    expect(nightsBetween("2026-12-30", "2027-01-02")).toBe(3);
  });

  it("handles a leap day", () => {
    expect(nightsBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(nightsBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("is unaffected by a DST transition in the host time zone", () => {
    // 29 March 2026 is the European DST jump; UTC midnight arithmetic ignores it.
    expect(nightsBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("rejects a reversed range rather than reporting negative nights", () => {
    expect(() => nightsBetween("2026-06-15", "2026-06-11")).toThrow(RangeError);
  });

  it("rejects a malformed or impossible date", () => {
    expect(() => nightsBetween("11-06-2026", "2026-06-15")).toThrow(RangeError);
    expect(() => nightsBetween("2026-6-1", "2026-06-15")).toThrow(RangeError);
    expect(() => nightsBetween("2026-02-30", "2026-03-02")).toThrow(RangeError);
    expect(() => nightsBetween("2026-13-01", "2026-13-02")).toThrow(RangeError);
  });
});

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters(BKC, BKC)).toBe(0);
  });

  it("returns whole metres", () => {
    expect(Number.isInteger(haversineMeters(WHITEFIELD, KORAMANGALA))).toBe(true);
  });

  it("matches a known Bengaluru cross-town distance within 1%", () => {
    const d = haversineMeters(WHITEFIELD, KORAMANGALA);
    expect(d).toBeGreaterThan(14000);
    expect(d).toBeLessThan(14300);
  });

  it("is symmetric", () => {
    expect(haversineMeters(WHITEFIELD, KORAMANGALA)).toBe(haversineMeters(KORAMANGALA, WHITEFIELD));
  });

  it("is deterministic", () => {
    expect(haversineMeters(BKC, north(2400))).toBe(haversineMeters(BKC, north(2400)));
  });
});

describe("estimateCommute — fixed bands", () => {
  it("walks at 80 m/min", () => {
    expect(estimateCommute(BKC, north(560))).toEqual({
      minutes: 7,
      mode: "walk",
      distanceMeters: 559,
    });
  });

  it("never reports a zero-minute commute", () => {
    expect(estimateCommute(BKC, BKC)).toEqual({ minutes: 1, mode: "walk", distanceMeters: 0 });
    expect(estimateCommute(BKC, north(40)).minutes).toBe(1);
  });

  it("stays a walk at exactly 12 minutes", () => {
    const c = estimateCommute(BKC, north(960));
    expect(c.mode).toBe("walk");
    expect(c.minutes).toBe(12);
  });

  it("switches to transit once the walk would exceed 12 minutes", () => {
    const c = estimateCommute(BKC, north(1040));
    expect(c.mode).toBe("transit");
    // 1,039 m at 18 km/h is 3 min, plus the fixed 6 min wait.
    expect(c.minutes).toBe(9);
  });

  it("stays transit to the 15 km edge", () => {
    const c = estimateCommute(BKC, north(15000));
    expect(c.mode).toBe("transit");
    expect(c.distanceMeters).toBeLessThanOrEqual(15000);
    expect(c.minutes).toBe(56);
  });

  it("drives beyond 15 km, with no wait added", () => {
    const c = estimateCommute(BKC, north(15100));
    expect(c.mode).toBe("drive");
    // 15,083 m at 28 km/h.
    expect(c.minutes).toBe(32);
  });

  it("is deterministic — the same pair twice gives the same object", () => {
    expect(estimateCommute(WHITEFIELD, KORAMANGALA)).toEqual(
      estimateCommute(WHITEFIELD, KORAMANGALA),
    );
  });
});

describe("describeCommute", () => {
  it("renders the badge copy", () => {
    expect(describeCommute({ minutes: 7, mode: "walk", distanceMeters: 559 })).toBe("7 min walk");
    expect(describeCommute({ minutes: 22, mode: "transit", distanceMeters: 4800 })).toBe(
      "22 min transit",
    );
    expect(describeCommute({ minutes: 35, mode: "drive", distanceMeters: 16000 })).toBe(
      "35 min drive",
    );
  });
});
