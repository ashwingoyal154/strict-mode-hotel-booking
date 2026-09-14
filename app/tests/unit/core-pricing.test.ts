import type { Rate, RateComponent } from "../../src/core/types.ts";
import { CurrencyMismatchError, money } from "../../src/core/money.ts";
import {
  PricingIntegrityError,
  assertComponentsSum,
  breakdown,
  componentsSum,
  driftBetween,
  perNightFrom,
  totalsEqual,
} from "../../src/core/pricing.ts";

/** A four-night stay whose 12% GST line and service fee sum exactly to the all-in. */
function rateWith(components: readonly RateComponent[], allInMinor: number, nights = 4): Rate {
  return {
    id: "off_1",
    propertyId: "prop_1",
    checkIn: "2026-06-11",
    checkOut: "2026-06-15",
    nights,
    currency: "INR",
    components,
    allInTotal: money(allInMinor, "INR"),
    perNight: money(Math.floor(allInMinor / nights), "INR"),
    breakfastIncluded: true,
    refundableUntil: "2026-06-09T12:30:00.000Z",
    channel: "fixture",
    supplierRef: "sup-1",
    sourceId: "src_a",
    tariffPerNight: money(Math.floor(allInMinor / nights), "INR"),
    holdable: false,
  };
}

const BASE: RateComponent = { kind: "base", label: "Room, 4 nights", amount: money(3000000, "INR") };
const GST: RateComponent = { kind: "tax", label: "GST 12%", amount: money(360000, "INR") };
const FEE: RateComponent = { kind: "fee", label: "Service fee", amount: money(120000, "INR") };

describe("componentsSum", () => {
  it("sums components in their own currency", () => {
    expect(componentsSum([BASE, GST, FEE])).toEqual(money(3480000, "INR"));
  });

  it("refuses a rate with no components rather than inventing a zero", () => {
    expect(() => componentsSum([])).toThrow(PricingIntegrityError);
  });
});

describe("assertComponentsSum — the 'one number' guarantee", () => {
  it("passes when the parts equal the whole exactly", () => {
    expect(() => assertComponentsSum(rateWith([BASE, GST, FEE], 3480000))).not.toThrow();
  });

  it("throws when the parts are one paisa short", () => {
    expect(() => assertComponentsSum(rateWith([BASE, GST, FEE], 3480001))).toThrow(PricingIntegrityError);
  });

  it("throws when the parts are one paisa over", () => {
    expect(() => assertComponentsSum(rateWith([BASE, GST, FEE], 3479999))).toThrow(PricingIntegrityError);
  });

  it("names the offending rate and both figures", () => {
    expect(() => assertComponentsSum(rateWith([BASE, GST, FEE], 3480001))).toThrow(
      /off_1: components sum to ₹34,800\.00 but allInTotal is ₹34,800\.01/,
    );
  });

  it("throws when a component is in another currency", () => {
    const foreign: RateComponent = { kind: "fee", label: "Resort fee", amount: money(1000, "USD") };
    expect(() => assertComponentsSum(rateWith([BASE, GST, foreign], 3480000))).toThrow(
      PricingIntegrityError,
    );
  });

  it("throws when allInTotal is in another currency than the rate", () => {
    const rate = rateWith([BASE, GST, FEE], 3480000);
    const mismatched: Rate = { ...rate, allInTotal: money(3480000, "USD") };
    expect(() => assertComponentsSum(mismatched)).toThrow(PricingIntegrityError);
  });
});

describe("perNightFrom", () => {
  it("floors, leaving the remainder in the authoritative total", () => {
    // 4 nights of ₹8,700.25 cannot be shown per night without losing a paisa.
    expect(perNightFrom(money(3480101, "INR"), 4)).toEqual(money(870025, "INR"));
  });

  it("never rounds a per-night figure up past what is owed", () => {
    const total = money(3480003, "INR");
    const perNight = perNightFrom(total, 4);
    expect(perNight.minor * 4).toBeLessThanOrEqual(total.minor);
  });

  it("divides evenly when it can", () => {
    expect(perNightFrom(money(3480000, "INR"), 4)).toEqual(money(870000, "INR"));
    expect(perNightFrom(money(870000, "INR"), 1)).toEqual(money(870000, "INR"));
  });

  it("rejects a zero-night stay instead of dividing by zero", () => {
    expect(() => perNightFrom(money(3480000, "INR"), 0)).toThrow(PricingIntegrityError);
  });

  it("rejects negative and fractional night counts", () => {
    expect(() => perNightFrom(money(100, "INR"), -1)).toThrow(PricingIntegrityError);
    expect(() => perNightFrom(money(100, "INR"), 1.5)).toThrow(PricingIntegrityError);
  });
});

describe("breakdown", () => {
  it("splits by kind and keeps the stored total authoritative", () => {
    const rate = rateWith([BASE, GST, FEE], 3480000);
    expect(breakdown(rate)).toEqual({
      base: money(3000000, "INR"),
      taxes: money(360000, "INR"),
      fees: money(120000, "INR"),
      total: money(3480000, "INR"),
    });
  });

  it("reports zeroes for kinds a rate does not carry", () => {
    const rate = rateWith([BASE], 3000000);
    expect(breakdown(rate).taxes).toEqual(money(0, "INR"));
    expect(breakdown(rate).fees).toEqual(money(0, "INR"));
  });

  it("adds multiple lines of the same kind", () => {
    const rate = rateWith([BASE, GST, GST], 3720000);
    expect(breakdown(rate).taxes).toEqual(money(720000, "INR"));
  });
});

describe("totalsEqual", () => {
  it("is true only for the same currency and the same minor units", () => {
    expect(totalsEqual(money(3480000, "INR"), money(3480000, "INR"))).toBe(true);
    expect(totalsEqual(money(3480000, "INR"), money(3480001, "INR"))).toBe(false);
    expect(totalsEqual(money(3480000, "INR"), money(3480000, "USD"))).toBe(false);
  });
});

describe("driftBetween", () => {
  it("returns null when nothing moved", () => {
    expect(driftBetween(money(3480000, "INR"), money(3480000, "INR"))).toBeNull();
  });

  it("describes an increase with the exact delta", () => {
    const detail = driftBetween(money(3480000, "INR"), money(3520000, "INR"));
    expect(detail).not.toBeNull();
    expect(detail?.kind).toBe("price_drift");
    expect(detail?.deltaMinor).toBe(40000);
    expect(detail?.message).toBe(
      "This rate moved from ₹34,800 to ₹35,200 — ₹400 more than you accepted",
    );
  });

  it("describes a decrease, because a silent drop is still a changed total", () => {
    const detail = driftBetween(money(3520000, "INR"), money(3480000, "INR"));
    expect(detail?.deltaMinor).toBe(-40000);
    expect(detail?.message).toBe(
      "This rate moved from ₹35,200 to ₹34,800 — ₹400 less than you accepted",
    );
  });

  it("catches a one-paisa move — A3 is to the cent", () => {
    expect(driftBetween(money(3480000, "INR"), money(3480001, "INR"))?.deltaMinor).toBe(1);
  });

  it("refuses to compare across currencies", () => {
    expect(() => driftBetween(money(3480000, "INR"), money(3480000, "USD"))).toThrow(
      CurrencyMismatchError,
    );
  });
});
