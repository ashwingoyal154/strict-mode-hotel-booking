import { FIXTURE_ANCHORS, resolveAnchor } from "../../src/supply/fixtures/anchors.ts";
import { FIXTURE_PROPERTIES, propertiesNear } from "../../src/supply/fixtures/properties.ts";
import { ratesFor } from "../../src/supply/fixtures/rates.ts";
import { DRIFT_MARKER_SUFFIX, SOLD_OUT_MARKER_SUFFIX } from "../../src/supply/fixtures/adversarial.ts";
import { haversineMeters } from "../../src/core/commute.ts";
import type { SearchQuery } from "../../src/core/types.ts";

const SOURCE_IDS = ["fx-alpha", "fx-beta", "fx-gamma", "fx-delta"];

function queryFor(anchorLabel: string, checkIn: string, checkOut: string): SearchQuery {
  const anchor = resolveAnchor(anchorLabel);
  if (!anchor) throw new Error(`test setup: could not resolve anchor "${anchorLabel}"`);
  return { anchor, checkIn, checkOut, guests: 1, rooms: 1 };
}

// ---------- anchors ----------

describe("FIXTURE_ANCHORS / resolveAnchor", () => {
  it("has at least 6 anchors across the required metros", () => {
    expect(FIXTURE_ANCHORS.length).toBeGreaterThanOrEqual(6);
    const cities = new Set(FIXTURE_ANCHORS.map((a) => a.city));
    for (const city of ["Mumbai", "Bengaluru", "Gurugram", "Hyderabad", "Pune"]) {
      expect(cities.has(city)).toBe(true);
    }
  });

  it("resolves case- and punctuation-insensitively", () => {
    expect(resolveAnchor("BKC")?.city).toBe("Mumbai");
    expect(resolveAnchor("  bkc!! ")?.city).toBe("Mumbai");
    expect(resolveAnchor("Bandra-Kurla, Complex")?.city).toBe("Mumbai");
  });

  it("resolves common aliases", () => {
    expect(resolveAnchor("cyber city")?.label).toContain("Cyber City");
    expect(resolveAnchor("hitec")?.label).toContain("HITEC City");
    expect(resolveAnchor("gurgaon")?.label).toContain("Cyber City");
  });

  it("returns null for nonsense input", () => {
    expect(resolveAnchor("")).toBeNull();
    expect(resolveAnchor("Antarctica Research Base")).toBeNull();
  });
});

// ---------- properties ----------

describe("FIXTURE_PROPERTIES", () => {
  it("has 35-50 properties", () => {
    expect(FIXTURE_PROPERTIES.length).toBeGreaterThanOrEqual(35);
    expect(FIXTURE_PROPERTIES.length).toBeLessThanOrEqual(50);
  });

  it("has unique property ids", () => {
    const ids = new Set(FIXTURE_PROPERTIES.map((p) => p.id));
    expect(ids.size).toBe(FIXTURE_PROPERTIES.length);
  });

  it("spreads true distance from 200m to 14km across at least one anchor", () => {
    const bkc = FIXTURE_ANCHORS.find((a) => a.city === "Mumbai")!;
    const distances = FIXTURE_PROPERTIES.map((p) => haversineMeters(p.geo, bkc.geo));
    expect(Math.min(...distances)).toBeLessThan(1000);
    expect(Math.max(...distances)).toBeGreaterThan(5000);
  });

  it("mixes workReady roughly 60/40", () => {
    const workReadyCount = FIXTURE_PROPERTIES.filter((p) => p.workReady).length;
    const ratio = workReadyCount / FIXTURE_PROPERTIES.length;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.85);
  });

  it("only uses the three allowed cityTier values", () => {
    for (const p of FIXTURE_PROPERTIES) {
      expect(["tier1", "tier2", "metro"]).toContain(p.cityTier);
    }
  });

  it("propertiesNear filters by true great-circle distance", () => {
    const bkc = FIXTURE_ANCHORS.find((a) => a.city === "Mumbai")!;
    const near = propertiesNear(bkc.geo, 2000);
    expect(near.length).toBeGreaterThan(0);
    for (const p of near) {
      expect(haversineMeters(p.geo, bkc.geo)).toBeLessThanOrEqual(2000);
    }
    const wider = propertiesNear(bkc.geo, 50_000);
    expect(wider.length).toBeGreaterThanOrEqual(near.length);
  });

  it("invents every property name — no real hotel brand appears anywhere", () => {
    const REAL_BRANDS = [
      "taj", "marriott", "hyatt", "vivanta", "oberoi", "itc", "leela", "radisson",
      "novotel", "holiday inn", "hilton", "sheraton", "westin", "ibis", "lemon tree",
      "accor", "four seasons", "ritz-carlton", "ritz carlton", "conrad", "fairmont",
      "intercontinental", "le meridien", "courtyard", "trident", "wyndham",
    ];
    for (const p of FIXTURE_PROPERTIES) {
      const haystack = `${p.name} ${p.brand ?? ""}`.toLowerCase();
      for (const brand of REAL_BRANDS) {
        expect(haystack.includes(brand)).toBe(false);
      }
    }
  });
});

// ---------- rates: determinism ----------

describe("ratesFor determinism", () => {
  it("returns identical output for identical inputs, every time", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    const property = FIXTURE_PROPERTIES[0]!;
    const first = ratesFor(property, query, "fx-alpha");
    const second = ratesFor(property, query, "fx-alpha");
    expect(second).toEqual(first);
  });

  it("varies by sourceId and by checkIn", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    const property = FIXTURE_PROPERTIES[0]!;
    const alpha = ratesFor(property, query, "fx-alpha");
    const beta = ratesFor(property, query, "fx-beta");
    expect(alpha[0]!.allInTotal).not.toEqual(beta[0]!.allInTotal);

    const laterQuery = queryFor("BKC", "2026-12-01", "2026-12-05");
    const later = ratesFor(property, laterQuery, "fx-alpha");
    expect(later[0]!.id).not.toBe(alpha[0]!.id);
  });

  it("produces 1 or 2 rates per property", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    for (const property of FIXTURE_PROPERTIES) {
      const rates = ratesFor(property, query, "fx-alpha");
      expect(rates.length).toBeGreaterThanOrEqual(1);
      expect(rates.length).toBeLessThanOrEqual(2);
    }
  });
});

// ---------- rates: component sums ----------

describe("ratesFor component sums", () => {
  const dateRanges: Array<[string, string]> = [
    ["2026-10-12", "2026-10-16"],
    ["2026-11-01", "2026-11-02"],
    ["2027-01-15", "2027-01-22"],
  ];

  it("every component list sums exactly to allInTotal, for every fixture property x anchor x date range x source", () => {
    for (const anchor of FIXTURE_ANCHORS) {
      for (const [checkIn, checkOut] of dateRanges) {
        const query: SearchQuery = { anchor, checkIn, checkOut, guests: 1, rooms: 1 };
        for (const property of FIXTURE_PROPERTIES) {
          for (const sourceId of SOURCE_IDS) {
            const rates = ratesFor(property, query, sourceId);
            for (const rate of rates) {
              const sum = rate.components.reduce((acc, c) => acc + c.amount.minor, 0);
              expect(sum).toBe(rate.allInTotal.minor);
              // Integer minor units only, never floats.
              expect(Number.isInteger(rate.allInTotal.minor)).toBe(true);
              for (const c of rate.components) {
                expect(Number.isInteger(c.amount.minor)).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("includes a 12% GST component and a service fee on some rates", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    let sawFee = false;
    for (const property of FIXTURE_PROPERTIES) {
      const rates = ratesFor(property, query, "fx-alpha");
      for (const rate of rates) {
        const tax = rate.components.find((c) => c.kind === "tax");
        expect(tax).toBeDefined();
        const base = rate.components.find((c) => c.kind === "base")!;
        // GST is rounded to whole rupees PER NIGHT and then multiplied by nights,
        // so that per-night figures are real money (no "₹6,581.46/night").
        const basePerNight = base.amount.minor / rate.nights;
        const expectedPerNight = Math.round((basePerNight * 0.12) / 100) * 100;
        expect(tax!.amount.minor).toBe(expectedPerNight * rate.nights);
        if (rate.components.some((c) => c.kind === "fee")) sawFee = true;
      }
    }
    expect(sawFee).toBe(true);
  });

  it("has a realistic mix of non-refundable rates (~35%)", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    let total = 0;
    let nonRefundable = 0;
    for (const property of FIXTURE_PROPERTIES) {
      for (const sourceId of SOURCE_IDS) {
        for (const rate of ratesFor(property, query, sourceId)) {
          total += 1;
          if (rate.refundableUntil === null) nonRefundable += 1;
        }
      }
    }
    const ratio = nonRefundable / total;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.55);
  });
});

// ---------- adversarial markers ----------

describe("adversarial marker offers", () => {
  it("has an addressable offer id that always drifts", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    const drifter = FIXTURE_PROPERTIES.find((p) => p.id === "prop-bkc-canary-drift")!;
    expect(drifter).toBeDefined();
    const rates = ratesFor(drifter, query, "fx-alpha");
    expect(rates.some((r) => r.id.endsWith(DRIFT_MARKER_SUFFIX))).toBe(true);
  });

  it("has an addressable offer id that is always sold out", () => {
    const query = queryFor("BKC", "2026-11-10", "2026-11-14");
    const soldOut = FIXTURE_PROPERTIES.find((p) => p.id === "prop-bkc-canary-soldout")!;
    expect(soldOut).toBeDefined();
    const rates = ratesFor(soldOut, query, "fx-alpha");
    expect(rates.some((r) => r.id.endsWith(SOLD_OUT_MARKER_SUFFIX))).toBe(true);
  });
});
