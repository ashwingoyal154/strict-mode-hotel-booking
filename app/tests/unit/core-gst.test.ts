import type { Booking, LegalEntity, Rate } from "../../src/core/types.ts";
import { CurrencyMismatchError, money } from "../../src/core/money.ts";
import { PricingIntegrityError } from "../../src/core/pricing.ts";
import {
  GST_STATE_NAMES,
  InvoiceNumberTooLongError,
  SAC_ACCOMMODATION,
  buildInvoice,
  financialYearOf,
  gstForStay,
  gstRatePercentForTariff,
  gstinCheckDigit,
  invoiceNumber,
  isValidGstin,
} from "../../src/core/gst.ts";
import { booking, londonProperty, property, rate } from "./core-builders.ts";

const inr = (rupees: number) => money(rupees * 100, "INR");

// ---------- slabs ----------

describe("gstRatePercentForTariff — GST 2.0, effective 22 Sep 2025", () => {
  /*
   * Verified against published sources, not memory:
   *  - Notification 15/2025-CT(R) (17 Sep 2025, effective 22 Sep 2025): accommodation
   *    of value ≤ ₹7,500 per unit per day is 5% without ITC; above ₹7,500 it is 18%.
   *    https://taxguru.in/goods-and-service-tax/hospitality-sector-account-gst-2-0-practical-faqs.html
   *  - The ≤ ₹1,000 exemption no longer exists: Notification 04/2022-CT(R) omitted
   *    entry 14 of Notification 12/2017-CT(R) with effect from 18 Jul 2022.
   *    https://taxguru.in/goods-and-service-tax/gst-hotel-guest-house-accommodation-current-legal-position.html
   * So a ₹1,000 room is 5%, not 0% — see the report for the contract discrepancy.
   */
  it("charges 5% at exactly ₹1,000 — the old exemption was withdrawn on 18 Jul 2022", () => {
    expect(gstRatePercentForTariff(inr(1000))).toBe(5);
  });

  it("charges 5% at ₹1,001", () => {
    expect(gstRatePercentForTariff(inr(1001))).toBe(5);
  });

  it("charges 5% at exactly ₹7,500 — the slab is inclusive", () => {
    expect(gstRatePercentForTariff(inr(7500))).toBe(5);
  });

  it("charges 18% at ₹7,501, and at one paisa over ₹7,500", () => {
    expect(gstRatePercentForTariff(inr(7501))).toBe(18);
    expect(gstRatePercentForTariff(money(750001, "INR"))).toBe(18);
  });

  it("charges 5% on a very cheap or complimentary tariff", () => {
    expect(gstRatePercentForTariff(inr(500))).toBe(5);
    expect(gstRatePercentForTariff(inr(0))).toBe(5);
  });

  it("refuses a tariff not in INR, and a negative one", () => {
    expect(() => gstRatePercentForTariff(money(10000, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => gstRatePercentForTariff(money(-1, "INR"))).toThrow(RangeError);
  });
});

describe("gstForStay", () => {
  it("rounds tax per night to whole rupees and multiplies by nights", () => {
    expect(gstForStay(inr(7500), 3)).toEqual({ ratePercent: 5, taxPerNight: inr(375), tax: inr(1125) });
    // 18% of ₹7,501 = ₹1,350.18 → ₹1,350
    expect(gstForStay(inr(7501), 2)).toEqual({ ratePercent: 18, taxPerNight: inr(1350), tax: inr(2700) });
  });

  it("rounds a rupee tie half to even, in both directions", () => {
    expect(gstForStay(inr(4550), 1).taxPerNight).toEqual(inr(228)); // 227.5 → 228
    expect(gstForStay(inr(4570), 1).taxPerNight).toEqual(inr(228)); // 228.5 → 228
    expect(gstForStay(inr(7525), 1).taxPerNight).toEqual(inr(1354)); // 1,354.5 → 1,354
    expect(gstForStay(inr(7575), 1).taxPerNight).toEqual(inr(1364)); // 1,363.5 → 1,364
  });

  it("handles a tariff with paise", () => {
    expect(gstForStay(money(100050, "INR"), 1).taxPerNight).toEqual(inr(50)); // 5% of ₹1,000.50 = ₹50.025
  });

  it("rejects a stay of less than one whole night", () => {
    expect(() => gstForStay(inr(5000), 0)).toThrow(RangeError);
    expect(() => gstForStay(inr(5000), 1.5)).toThrow(RangeError);
  });
});

// ---------- GSTIN ----------

describe("GSTIN check digit (mod 36)", () => {
  /*
   * Publicly documented valid GSTINs, both verified by web search on 13 Sep 2026
   * and re-computed with this algorithm:
   *  - 27AAPFU0939F1ZV — the standard example in taxid.pro's India tax-id guide
   *    (https://taxid.pro/docs/countries/india) and in "Build an Offline GSTIN
   *    Validator in 62 Lines of Python" (https://dev.to/automate-archit/build-an-offline-gstin-validator-in-62-lines-of-python-7df),
   *    which states its check character is V.
   *  - 29AAGCB7383J1Z4 — listed as valid in the same dev.to article's sample set.
   * (NIC's e-invoice sandbox GSTIN 29AWGPV7107B1Z1 was also checked and does NOT
   * pass the checksum, so it is deliberately not used here.)
   */
  it("computes the published check digits", () => {
    expect(gstinCheckDigit("27AAPFU0939F1Z")).toBe("V");
    expect(gstinCheckDigit("29AAGCB7383J1Z")).toBe("4");
  });

  it("validates the published GSTINs", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("29AAGCB7383J1Z4")).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidGstin("27AAPFU0939F1ZX")).toBe(false);
  });

  it("catches a single-character substitution anywhere in the first 14", () => {
    const good = "27AAPFU0939F1ZV";
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 2; i < 14; i++) {
      for (const ch of alphabet) {
        if (ch === good.charAt(i)) continue;
        const mutated = good.slice(0, i) + ch + good.slice(i + 1);
        expect(gstinCheckDigit(mutated.slice(0, 14))).not.toBe("V");
      }
    }
  });

  it("round-trips a constructed GSTIN", () => {
    const first14 = "36ABCDE1234F1Z";
    expect(isValidGstin(first14 + gstinCheckDigit(first14))).toBe(true);
  });

  it("rejects the wrong length, an unknown state and a lowercase GSTIN", () => {
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false);
    expect(isValidGstin("27aapfu0939f1zv")).toBe(false);
    expect(isValidGstin("")).toBe(false);
  });

  it("refuses to compute a digit from malformed input", () => {
    expect(() => gstinCheckDigit("27AAPFU0939F1")).toThrow(RangeError);
    expect(() => gstinCheckDigit("27AAPFU0939F1#")).toThrow(RangeError);
  });

  it("names the states the product ships in", () => {
    expect(GST_STATE_NAMES["27"]).toBe("Maharashtra");
    expect(GST_STATE_NAMES["29"]).toBe("Karnataka");
    expect(GST_STATE_NAMES["06"]).toBe("Haryana");
    expect(GST_STATE_NAMES["36"]).toBe("Telangana");
    expect(GST_STATE_NAMES["07"]).toBe("Delhi");
    expect(GST_STATE_NAMES["33"]).toBe("Tamil Nadu");
    expect(GST_STATE_NAMES["24"]).toBe("Gujarat");
    expect(GST_STATE_NAMES["09"]).toBe("Uttar Pradesh");
    expect(GST_STATE_NAMES["19"]).toBe("West Bengal");
    expect(GST_STATE_NAMES["32"]).toBe("Kerala");
  });
});

// ---------- financial year and numbering ----------

describe("financialYearOf — April to March in IST", () => {
  it("starts the year on 1 April", () => {
    expect(financialYearOf("2026-04-01")).toBe("2026-27");
    expect(financialYearOf("2026-03-31")).toBe("2025-26");
    expect(financialYearOf("2027-01-15")).toBe("2026-27");
  });

  it("reads an instant in Asia/Kolkata, not UTC", () => {
    expect(financialYearOf("2027-03-31T18:29:59.999Z")).toBe("2026-27"); // 23:59:59 IST, 31 Mar
    expect(financialYearOf("2027-03-31T18:30:00.000Z")).toBe("2027-28"); // 00:00 IST, 1 Apr
  });

  it("rejects garbage", () => {
    expect(() => financialYearOf("soon")).toThrow(RangeError);
  });
});

describe("invoiceNumber — GST rule 46", () => {
  it("renders the documented shape at exactly 16 characters", () => {
    const n = invoiceNumber("ACME", "2026-27", 123);
    expect(n).toBe("ACME/2627/000123");
    expect(n).toHaveLength(16);
  });

  it("throws past 16 characters", () => {
    expect(() => invoiceNumber("ACMEX", "2026-27", 1)).toThrow(InvoiceNumberTooLongError);
  });

  it("allows a longer sequence when the prefix leaves room", () => {
    expect(invoiceNumber("AB", "2026-27", 1234567)).toBe("AB/2627/1234567");
  });

  it("rejects a non-consecutive year, a zero sequence and illegal characters", () => {
    expect(() => invoiceNumber("ACME", "2026-28", 1)).toThrow(RangeError);
    expect(() => invoiceNumber("ACME", "2026-27", 0)).toThrow(RangeError);
    expect(() => invoiceNumber("AC_E", "2026-27", 1)).toThrow(RangeError);
  });
});

// ---------- invoices ----------

const MH_ENTITY: LegalEntity = {
  id: "acme",
  legalName: "ACME Travel Pvt Ltd",
  gstin: "27AAPFU0939F1ZV",
  stateCode: "27",
  address: "1 Nariman Point, Mumbai",
  settlementCurrency: "INR",
  reportingCurrency: "INR",
  invoiceSeriesPrefix: "ACME",
};

const KA_ENTITY: LegalEntity = {
  ...MH_ENTITY,
  gstin: `29AAACA1234A1Z${gstinCheckDigit("29AAACA1234A1Z")}`,
  stateCode: "29",
  address: "1 MG Road, Bengaluru",
};

const BLR = property({
  id: "prop_blr_1",
  name: "Whitefield Commons",
  addressLine: "ITPL Main Road, Whitefield",
  city: "Bengaluru",
  stateCode: "29",
  supplierGstin: "29AAGCB7383J1Z4",
});

/** An Indian rate shaped exactly as Stream B builds one: room charge + GST from gstForStay. */
function indianRate(tariffRupees: number, nights: number, checkIn: string, checkOut: string): Rate {
  const tariff = inr(tariffRupees);
  const g = gstForStay(tariff, nights);
  const base = money(tariff.minor * nights, "INR");
  const total = money(base.minor + g.tax.minor, "INR");
  return rate({
    id: "off_blr_1",
    propertyId: BLR.id,
    checkIn,
    checkOut,
    nights,
    components: [
      { kind: "base", label: "Room charge", amount: base },
      { kind: "tax", label: `GST (${g.ratePercent}%)`, amount: g.tax },
    ],
    allInTotal: total,
    perNight: money(Math.floor(total.minor / nights), "INR"),
    tariffPerNight: tariff,
  });
}

function invoiceFor(b: Booking, entity: LegalEntity) {
  return buildInvoice({
    id: "inv_1",
    booking: b,
    entity,
    number: "ACME/2627/000001",
    financialYear: "2026-27",
    issuedAt: "2026-10-14T06:00:00.000Z",
  });
}

describe("buildInvoice — GST tax invoice", () => {
  const eighteen = booking({ offer: { property: BLR, rate: indianRate(9000, 2, "2026-10-11", "2026-10-13") } });

  it("is a GST tax invoice from the hotel to the entity, placed where the room is", () => {
    const inv = invoiceFor(eighteen, MH_ENTITY);
    expect(inv.kind).toBe("gst_tax_invoice");
    expect(inv.supplier).toEqual({
      name: "Whitefield Commons",
      gstin: "29AAGCB7383J1Z4",
      stateCode: "29",
      address: "ITPL Main Road, Whitefield",
    });
    expect(inv.recipient).toEqual({
      name: "ACME Travel Pvt Ltd",
      gstin: "27AAPFU0939F1ZV",
      stateCode: "27",
      address: "1 Nariman Point, Mumbai",
    });
    expect(inv.placeOfSupply).toBe("29");
    expect(inv.number).toBe("ACME/2627/000001");
    expect(inv.financialYear).toBe("2026-27");
  });

  it("itemises one SAC 996311 line split into CGST and SGST", () => {
    const inv = invoiceFor(eighteen, MH_ENTITY);
    expect(inv.lines).toEqual([
      {
        description: "Room accommodation · 2 nights · 11–13 Oct",
        sac: SAC_ACCOMMODATION,
        taxableValue: inr(18000),
        taxRatePercent: 18,
        cgst: inr(1620),
        sgst: inr(1620),
        igst: null,
        otherTax: null,
        total: inr(21240),
      },
    ]);
    expect(inv.taxableTotal).toEqual(inr(18000));
    expect(inv.taxTotal).toEqual(inr(3240));
    expect(inv.grandTotal).toEqual(inr(21240));
  });

  it("says ITC is claimable when the entity is registered in the hotel's state", () => {
    expect(invoiceFor(eighteen, KA_ENTITY).itc).toEqual({
      claimable: true,
      reason: "Charged as Karnataka CGST + SGST to your Karnataka GSTIN",
    });
  });

  it("says ITC is not claimable from another state, and why", () => {
    expect(invoiceFor(eighteen, MH_ENTITY).itc).toEqual({
      claimable: false,
      reason:
        "Charged as Karnataka CGST + SGST — your GSTIN is registered in Maharashtra, so this credit can't be claimed there",
    });
  });

  it("says ITC is not claimable when the entity has no GSTIN", () => {
    expect(invoiceFor(eighteen, { ...MH_ENTITY, gstin: null, stateCode: null }).itc).toEqual({
      claimable: false,
      reason: "Charged as Karnataka CGST + SGST — your entity has no GSTIN on file, so this credit can't be claimed",
    });
  });

  it("carries no ITC under the 5% slab, and splits an odd-rupee tax exactly", () => {
    // ₹7,500 × 5% = ₹375/night × 3 = ₹1,125 — odd in rupees.
    const five = booking({ offer: { property: BLR, rate: indianRate(7500, 3, "2026-10-11", "2026-10-14") } });
    const inv = invoiceFor(five, KA_ENTITY);
    const line = inv.lines[0];
    expect(line?.taxRatePercent).toBe(5);
    expect(line?.description).toBe("Room accommodation · 3 nights · 11–14 Oct");
    expect(line?.cgst).toEqual(money(56250, "INR"));
    expect(line?.sgst).toEqual(money(56250, "INR"));
    expect((line?.cgst?.minor ?? 0) + (line?.sgst?.minor ?? 0)).toBe(112500);
    expect(inv.itc).toEqual({ claimable: false, reason: "The 5% slab carries no input tax credit" });
  });

  it("splits a tax that is odd in paise with CGST taking the floor", () => {
    // A hand-built rate whose GST is odd in paise; the tariff is chosen so the slab agrees.
    const tax = money(112501, "INR");
    const r = rate({
      nights: 1,
      checkIn: "2026-10-11",
      checkOut: "2026-10-12",
      components: [
        { kind: "base", label: "Room charge", amount: inr(7500) },
        { kind: "tax", label: "GST (18%)", amount: tax },
      ],
      allInTotal: money(750000 + 112501, "INR"),
      perNight: money(750000 + 112501, "INR"),
      tariffPerNight: inr(7500),
    });
    // The slab says ₹375, so the builder must refuse rather than print a mismatched invoice.
    expect(() => invoiceFor(booking({ offer: { property: BLR, rate: r } }), KA_ENTITY)).toThrow(PricingIntegrityError);
  });

  it("reconciles to the all-in total exactly across tariffs, slabs and stay lengths", () => {
    for (const tariff of [999, 1000, 1001, 4550, 4570, 7499, 7500, 7501, 7525, 12345]) {
      for (let nights = 1; nights <= 5; nights++) {
        const r = indianRate(tariff, nights, "2026-10-01", `2026-10-${String(1 + nights).padStart(2, "0")}`);
        const inv = invoiceFor(booking({ offer: { property: BLR, rate: r } }), KA_ENTITY);
        const lineSum = inv.lines.reduce((sum, l) => sum + l.total.minor, 0);
        const parts = inv.lines.reduce(
          (sum, l) => sum + l.taxableValue.minor + (l.cgst?.minor ?? 0) + (l.sgst?.minor ?? 0),
          0,
        );
        expect(lineSum).toBe(r.allInTotal.minor);
        expect(parts).toBe(r.allInTotal.minor);
        expect(inv.taxableTotal.minor + inv.taxTotal.minor).toBe(inv.grandTotal.minor);
        expect(inv.grandTotal).toEqual(r.allInTotal);
      }
    }
  });

  it("refuses a rate whose components do not sum to its total", () => {
    const r = indianRate(9000, 2, "2026-10-11", "2026-10-13");
    const broken = { ...r, allInTotal: money(r.allInTotal.minor + 1, "INR") };
    expect(() => invoiceFor(booking({ offer: { property: BLR, rate: broken } }), KA_ENTITY)).toThrow(
      PricingIntegrityError,
    );
  });
});

describe("buildInvoice — tax summary outside India", () => {
  it("itemises London VAT as its own line and says it is not a GST document", () => {
    const r = rate({
      id: "off_lon_1",
      currency: "GBP",
      nights: 1,
      components: [
        { kind: "base", label: "Room charge", amount: money(20000, "GBP") },
        { kind: "tax", label: "VAT (20%)", amount: money(4000, "GBP") },
      ],
      allInTotal: money(24000, "GBP"),
      perNight: money(24000, "GBP"),
      tariffPerNight: money(20000, "GBP"),
    });
    const inv = invoiceFor(booking({ offer: { property: londonProperty(), rate: r } }), MH_ENTITY);
    expect(inv.kind).toBe("tax_summary");
    expect(inv.placeOfSupply).toBeNull();
    expect(inv.lines).toEqual([
      {
        description: "Room charge",
        sac: null,
        taxableValue: money(20000, "GBP"),
        taxRatePercent: 0,
        cgst: null,
        sgst: null,
        igst: null,
        otherTax: null,
        total: money(20000, "GBP"),
      },
      {
        description: "VAT (20%)",
        sac: null,
        taxableValue: money(0, "GBP"),
        taxRatePercent: 20,
        cgst: null,
        sgst: null,
        igst: null,
        otherTax: money(4000, "GBP"),
        total: money(4000, "GBP"),
      },
    ]);
    expect(inv.taxableTotal).toEqual(money(20000, "GBP"));
    expect(inv.taxTotal).toEqual(money(4000, "GBP"));
    expect(inv.grandTotal).toEqual(money(24000, "GBP"));
    expect(inv.itc).toEqual({ claimable: false, reason: "This is a tax summary, not a GST document" });
  });

  it("turns every non-base component, fees included, into an otherTax line that sums to the total", () => {
    const r = rate({
      currency: "AED",
      nights: 1,
      components: [
        { kind: "base", label: "Room charge", amount: money(100000, "AED") },
        { kind: "tax", label: "VAT (5%)", amount: money(5000, "AED") },
        { kind: "fee", label: "Municipality fee (7%)", amount: money(7000, "AED") },
      ],
      allInTotal: money(112000, "AED"),
      perNight: money(112000, "AED"),
      tariffPerNight: money(100000, "AED"),
    });
    const dubai = property({ city: "Dubai", countryCode: "AE", cityTier: "global", stateCode: null, supplierGstin: null });
    const inv = invoiceFor(booking({ offer: { property: dubai, rate: r } }), MH_ENTITY);
    expect(inv.lines.map((l) => l.otherTax?.minor ?? null)).toEqual([null, 5000, 7000]);
    expect(inv.lines.map((l) => l.taxRatePercent)).toEqual([0, 5, 7]);
    expect(inv.lines.reduce((s, l) => s + l.total.minor, 0)).toBe(112000);
  });

  it("treats an Indian property priced in another currency as a summary", () => {
    const r = rate({
      currency: "USD",
      components: [{ kind: "base", label: "Room charge", amount: money(40000, "USD") }],
      allInTotal: money(40000, "USD"),
      perNight: money(10000, "USD"),
      tariffPerNight: money(10000, "USD"),
    });
    expect(invoiceFor(booking({ offer: { property: BLR, rate: r } }), MH_ENTITY).kind).toBe("tax_summary");
  });
});
