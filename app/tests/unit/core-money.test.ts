import {
  CurrencyMismatchError,
  addMoney,
  compareMoney,
  formatMoney,
  money,
  multiplyMoney,
  subMoney,
  sumMoney,
} from "../../src/core/money.ts";

describe("money()", () => {
  it("builds an amount from integer minor units", () => {
    expect(money(870000, "INR")).toEqual({ minor: 870000, currency: "INR" });
  });

  it("refuses a float, because a float cent is an unreproducible total", () => {
    expect(() => money(870000.5, "INR")).toThrow(RangeError);
    expect(() => money(Number.NaN, "INR")).toThrow(RangeError);
  });

  it("refuses an empty currency", () => {
    expect(() => money(1, "")).toThrow(RangeError);
  });

  it("accepts zero and negatives (overage arithmetic produces both)", () => {
    expect(money(0, "INR").minor).toBe(0);
    expect(money(-70000, "INR").minor).toBe(-70000);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts in integer minor units", () => {
    expect(addMoney(money(870000, "INR"), money(130000, "INR"))).toEqual(money(1000000, "INR"));
    expect(subMoney(money(870000, "INR"), money(800000, "INR"))).toEqual(money(70000, "INR"));
  });

  it("keeps 0.1 + 0.2 exact, which floats do not", () => {
    expect(addMoney(money(10, "INR"), money(20, "INR")).minor).toBe(30);
  });

  it("sums a list into an explicitly named currency", () => {
    const items = [money(776786, "INR"), money(93214, "INR")];
    expect(sumMoney(items, "INR")).toEqual(money(870000, "INR"));
  });

  it("sums an empty list to a typed zero", () => {
    expect(sumMoney([], "USD")).toEqual(money(0, "USD"));
  });

  it("multiplies only by an integer factor", () => {
    expect(multiplyMoney(money(70000, "INR"), 4)).toEqual(money(280000, "INR"));
    expect(() => multiplyMoney(money(70000, "INR"), 1.5)).toThrow(RangeError);
  });

  it("compares within a currency", () => {
    expect(compareMoney(money(1, "INR"), money(2, "INR"))).toBe(-1);
    expect(compareMoney(money(2, "INR"), money(1, "INR"))).toBe(1);
    expect(compareMoney(money(2, "INR"), money(2, "INR"))).toBe(0);
  });

  it("throws CurrencyMismatchError rather than mixing currencies", () => {
    const inr = money(100, "INR");
    const usd = money(100, "USD");
    expect(() => addMoney(inr, usd)).toThrow(CurrencyMismatchError);
    expect(() => subMoney(inr, usd)).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(inr, usd)).toThrow(CurrencyMismatchError);
    expect(() => sumMoney([inr, usd], "INR")).toThrow(CurrencyMismatchError);
  });
});

describe("formatMoney — INR groups Indian-style", () => {
  it("groups thousands", () => {
    expect(formatMoney(money(870000, "INR"))).toBe("₹8,700");
    expect(formatMoney(money(3480000, "INR"))).toBe("₹34,800");
  });

  it("groups lakhs in pairs, not threes", () => {
    expect(formatMoney(money(13480000, "INR"))).toBe("₹1,34,800");
  });

  it("groups crores in pairs too", () => {
    expect(formatMoney(money(123456789000, "INR"))).toBe("₹1,23,45,67,890");
  });

  it("leaves short amounts ungrouped", () => {
    expect(formatMoney(money(0, "INR"))).toBe("₹0");
    expect(formatMoney(money(70000, "INR"))).toBe("₹700");
    expect(formatMoney(money(100000, "INR"))).toBe("₹1,000");
  });
});

describe("formatMoney — other currencies group Western-style", () => {
  it("renders the documented symbols", () => {
    expect(formatMoney(money(124000, "USD"))).toBe("$1,240");
    expect(formatMoney(money(98000, "EUR"))).toBe("€980");
    expect(formatMoney(money(124000, "GBP"))).toBe("£1,240");
    expect(formatMoney(money(124000, "SGD"))).toBe("S$1,240");
  });

  it("spaces an alphabetic symbol and never a glyph", () => {
    expect(formatMoney(money(124000, "AED"))).toBe("AED 1,240");
  });

  it("falls back to the ISO code for an unknown currency", () => {
    expect(formatMoney(money(124000, "JPY"))).toBe("JPY 1,240");
  });

  it("groups in threes, not pairs", () => {
    expect(formatMoney(money(123456789000, "USD"))).toBe("$1,234,567,890");
  });
});

describe("formatMoney — minor units and sign", () => {
  it("hides minor units when they are zero", () => {
    expect(formatMoney(money(870000, "INR"))).toBe("₹8,700");
  });

  it("shows minor units when they are non-zero, even unasked", () => {
    expect(formatMoney(money(870050, "INR"))).toBe("₹8,700.50");
    expect(formatMoney(money(870005, "INR"))).toBe("₹8,700.05");
  });

  it("forces minor units when asked", () => {
    expect(formatMoney(money(870000, "INR"), { decimals: true })).toBe("₹8,700.00");
  });

  it("treats decimals:false as the default — it can never hide real paise", () => {
    expect(formatMoney(money(870050, "INR"), { decimals: false })).toBe("₹8,700.50");
  });

  it("puts the sign before the symbol", () => {
    expect(formatMoney(money(-70000, "INR"))).toBe("-₹700");
    expect(formatMoney(money(-124050, "USD"))).toBe("-$1,240.50");
  });

  it("is case-insensitive about the currency code", () => {
    expect(formatMoney(money(870000, "inr"))).toBe("₹8,700");
  });

  it("is deterministic across calls", () => {
    const m = money(13480099, "INR");
    expect(formatMoney(m)).toBe(formatMoney(m));
  });
});
