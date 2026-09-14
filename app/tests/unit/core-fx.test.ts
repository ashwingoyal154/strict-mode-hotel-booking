import { readFileSync } from "node:fs";

import { money } from "../../src/core/money.ts";
import {
  CURRENCY_EXPONENT,
  FxMismatchError,
  NoFxPinError,
  convert,
  convertVia,
  exponentOf,
  formatRate,
  monthLabel,
  pinMonthOf,
} from "../../src/core/fx.ts";
import { pin } from "./core-builders.ts";

const GBP_INR = pin("GBP", "INR", 106_250_000); // 1 GBP = ₹106.25

describe("exponents", () => {
  it("knows the minor-unit digits of the currencies the product touches", () => {
    for (const code of ["INR", "USD", "EUR", "GBP", "AED", "SGD"]) expect(CURRENCY_EXPONENT[code]).toBe(2);
    expect(CURRENCY_EXPONENT.JPY).toBe(0);
    expect(CURRENCY_EXPONENT.BHD).toBe(3);
    expect(CURRENCY_EXPONENT.KWD).toBe(3);
  });

  it("defaults an unknown code to 2 and ignores case", () => {
    expect(exponentOf("XYZ")).toBe(2);
    expect(exponentOf("jpy")).toBe(0);
  });
});

describe("convert — integer arithmetic with the currency exponents applied", () => {
  it("converts GBP to INR at a pin", () => {
    const c = convert(money(41200, "GBP"), GBP_INR); // £412.00
    expect(c.to).toEqual(money(4377500, "INR")); // ₹43,775.00
    expect(c.from).toEqual(money(41200, "GBP"));
    expect(c.fx).toBe(GBP_INR);
  });

  it("converts into JPY, which has no minor unit", () => {
    const c = convert(money(1000, "USD"), pin("USD", "JPY", 147_300_000)); // $10.00 at ¥147.30
    expect(c.to).toEqual(money(1473, "JPY"));
  });

  it("converts out of JPY, rounding into cents", () => {
    // ¥1,473 × 0.006789 = $10.000197 → 1000 cents
    const c = convert(money(1473, "JPY"), pin("JPY", "USD", 6789));
    expect(c.to).toEqual(money(1000, "USD"));
  });

  it("converts out of a three-exponent currency", () => {
    // BHD 1.500 × ₹222.50 = ₹333.75
    const c = convert(money(1500, "BHD"), pin("BHD", "INR", 222_500_000));
    expect(c.to).toEqual(money(33375, "INR"));
  });

  it("converts into a three-exponent currency", () => {
    // ₹333.75 × 0.004494 = BHD 1.49987… → 1.500
    const c = convert(money(33375, "INR"), pin("INR", "BHD", 4494));
    expect(c.to).toEqual(money(1500, "BHD"));
  });

  it("rounds a tie half to even, down as well as up", () => {
    const oneAndAHalf = pin("GBP", "INR", 1_500_000);
    expect(convert(money(1, "GBP"), oneAndAHalf).to.minor).toBe(2); // 1.5 → 2 (up, to even)
    expect(convert(money(3, "GBP"), oneAndAHalf).to.minor).toBe(4); // 4.5 → 4 (down, to even)
    expect(convert(money(5, "GBP"), oneAndAHalf).to.minor).toBe(8); // 7.5 → 8 (up)
    expect(convert(money(7, "GBP"), oneAndAHalf).to.minor).toBe(10); // 10.5 → 10 (down)
  });

  it("rounds a negative tie symmetrically", () => {
    const oneAndAHalf = pin("GBP", "INR", 1_500_000);
    expect(convert(money(-3, "GBP"), oneAndAHalf).to.minor).toBe(-4);
    expect(convert(money(-1, "GBP"), oneAndAHalf).to.minor).toBe(-2);
  });

  it("rounds a non-tie to the nearest unit", () => {
    expect(convert(money(1, "GBP"), pin("GBP", "INR", 1_400_000)).to.minor).toBe(1);
    expect(convert(money(1, "GBP"), pin("GBP", "INR", 1_600_000)).to.minor).toBe(2);
  });

  it("refuses a rate quoted from another currency", () => {
    expect(() => convert(money(100, "USD"), GBP_INR)).toThrow(FxMismatchError);
  });

  it("refuses a non-integer or non-positive rate", () => {
    expect(() => convert(money(100, "GBP"), pin("GBP", "INR", 106.25))).toThrow(RangeError);
    expect(() => convert(money(100, "GBP"), pin("GBP", "INR", 0))).toThrow(RangeError);
  });

  it("re-derives a stored conversion to the same minor unit (A11)", () => {
    const stored = JSON.parse(JSON.stringify(convertVia(money(52037, "GBP"), "INR", [GBP_INR])));
    expect(convert(stored.from, stored.fx)).toEqual(stored);
  });
});

describe("convertVia", () => {
  it("returns fx: null for the same currency", () => {
    const amount = money(870000, "INR");
    expect(convertVia(amount, "INR", [])).toEqual({ from: amount, to: amount, fx: null });
  });

  it("uses a direct pin when there is one", () => {
    const inverseToo = pin("INR", "GBP", 9412);
    const c = convertVia(money(41200, "GBP"), "INR", [inverseToo, GBP_INR]);
    expect(c.fx).toBe(GBP_INR);
    expect(c.to.minor).toBe(4377500);
  });

  it("converts INR to GBP through the inverse of the GBP→INR pin", () => {
    const c = convertVia(money(4377500, "INR"), "GBP", [GBP_INR]);
    // 10^12 ÷ 106,250,000 = 9,411.76… → 9,412 micros; ₹43,775 × 0.009412 = £412.0103 → £412.01
    expect(c.fx).toEqual({
      base: "INR",
      quote: "GBP",
      rateMicros: 9412,
      source: "pinned_monthly",
      pinMonth: "2026-09",
      asOf: "2026-09-01T00:00:00.000Z",
    });
    expect(c.to).toEqual(money(41201, "GBP"));
  });

  it("throws NoFxPinError when no pin links the currencies", () => {
    expect(() => convertVia(money(52000, "GBP"), "INR", [])).toThrow(NoFxPinError);
    expect(() => convertVia(money(52000, "GBP"), "INR", [])).toThrow("No pinned FX rate for GBP→INR");
  });

  it("never chains through a third currency", () => {
    const pins = [pin("GBP", "USD", 1_270_000), pin("USD", "INR", 84_000_000)];
    expect(() => convertVia(money(52000, "GBP"), "INR", pins)).toThrow(NoFxPinError);
  });
});

describe("months", () => {
  it("files an instant under its UTC calendar month", () => {
    expect(pinMonthOf(new Date("2026-09-14T09:00:00.000Z"))).toBe("2026-09");
    // 1 Oct 02:00 in Kolkata is still 30 Sep in UTC.
    expect(pinMonthOf(new Date("2026-10-01T02:00:00+05:30"))).toBe("2026-09");
    expect(pinMonthOf(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12");
  });

  it("rejects an invalid Date", () => {
    expect(() => pinMonthOf(new Date("nope"))).toThrow(RangeError);
  });

  it("labels a month from a fixed table", () => {
    expect(monthLabel("2026-09")).toBe("Sep");
    expect(monthLabel("2027-01")).toBe("Jan");
    expect(monthLabel("2027-12")).toBe("Dec");
    expect(() => monthLabel("2026-13")).toThrow(RangeError);
    expect(() => monthLabel("Sep 2026")).toThrow(RangeError);
  });
});

describe("formatRate", () => {
  it("renders the documented shape", () => {
    expect(formatRate(GBP_INR)).toBe("1 GBP = ₹106.25 · Sep pinned");
  });

  it("keeps micro precision for a small inverse rate", () => {
    expect(formatRate(pin("INR", "GBP", 9412))).toBe("1 INR = £0.009412 · Sep pinned");
  });

  it("shows at least two decimals, and names a spot rate as spot", () => {
    expect(formatRate(pin("USD", "INR", 84_000_000, { source: "spot", pinMonth: null }))).toBe("1 USD = ₹84.00 · spot");
  });

  it("groups the whole part by the quote currency's convention", () => {
    expect(formatRate(pin("BTC", "INR", 1_234_567_890_000))).toBe("1 BTC = ₹12,34,567.89 · Sep pinned");
    expect(formatRate(pin("USD", "JPY", 147_300_000, { pinMonth: "2026-10" }))).toBe("1 USD = JPY 147.30 · Oct pinned");
  });
});

describe("fx.ts source — no floats in the arithmetic", () => {
  const source = readFileSync(new URL("../../src/core/fx.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("does its conversion in BigInt", () => {
    expect(code).toContain("BigInt(amount.minor)");
    expect(code).toContain("BigInt(rate.rateMicros)");
  });

  it("uses no float rounding or parsing anywhere", () => {
    expect(code).not.toMatch(/Math\.(round|floor|ceil|trunc)|parseFloat|toFixed|toPrecision/);
  });
});
