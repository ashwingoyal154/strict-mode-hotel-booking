/**
 * India GST for hotel accommodation — GST 2.0, rates effective 22 Sep 2025.
 *
 * This is tax law, so every constant here was checked against a published
 * source rather than remembered:
 *  - Notification 15/2025-Central Tax (Rate), 17 Sep 2025, effective 22 Sep 2025,
 *    amending item 7 of Notification 11/2017-CT(R): accommodation whose value of
 *    supply is ≤ ₹7,500 per unit per day is 5% with no input tax credit; above
 *    ₹7,500 it is 18% with ITC.
 *  - There is NO 0% slab for rooms ≤ ₹1,000. That exemption (entry 14 of
 *    Notification 12/2017-CT(R)) was omitted by Notification 04/2022-CT(R) with
 *    effect from 18 Jul 2022, so such rooms fell into the 12% slab and, from
 *    22 Sep 2025, into 5%. The return type keeps `0` only because the frozen
 *    contract names it; this function never returns it.
 *  - GSTIN check digit: the published mod-36 algorithm (alternate weights 1, 2;
 *    each product contributes quotient + remainder in base 36).
 *  - Invoice numbers: CGST Rule 46(b) — consecutive, at most 16 characters of
 *    letters, digits, hyphen or slash, unique per financial year.
 *
 * Money stays integer: tax per night is rounded to whole rupees half-to-even,
 * and the CGST/SGST split is done in paise so the two halves always sum to the tax.
 */

import type { Booking, Invoice, InvoiceLine, InvoiceParty, IsoDate, IsoDateTime, LegalEntity, Money } from "./types.ts";
import { CurrencyMismatchError, formatMoney, money, multiplyMoney, subMoney, sumMoney } from "./money.ts";
import { assertComponentsSum, PricingIntegrityError } from "./pricing.ts";
import { formatDateRange } from "./format.ts";

/** SAC for room accommodation services (heading 9963, group 99631). */
export const SAC_ACCOMMODATION = "996311";

/** GST state and union-territory codes, as printed as the first two digits of a GSTIN. */
export const GST_STATE_NAMES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

/** Thrown when an invoice number would exceed the 16 characters CGST Rule 46 allows. */
export class InvoiceNumberTooLongError extends Error {
  readonly number: string;

  constructor(number: string) {
    super(`Invoice number "${number}" is ${number.length} characters; GST rule 46 allows at most 16`);
    this.name = "InvoiceNumberTooLongError";
    this.number = number;
  }
}

/** ₹7,500 in paise — the upper bound, inclusive, of the 5% slab. */
const FIVE_PERCENT_SLAB_MAX_MINOR = 750_000;

/** n ÷ d rounded half to even, for non-negative safe integers; % and exact division, never a float quotient. */
function divRoundHalfEven(n: number, d: number): number {
  const remainder = n % d;
  const quotient = (n - remainder) / d;
  const twice = remainder * 2;
  if (twice > d || (twice === d && quotient % 2 === 1)) return quotient + 1;
  return quotient;
}

/**
 * The GST rate for a room tariff per night, in INR: ≤ ₹7,500 → 5%, above → 18%.
 * Never 0 — the ≤ ₹1,000 exemption was withdrawn on 18 Jul 2022 (see file header).
 */
export function gstRatePercentForTariff(tariffPerNight: Money): 0 | 5 | 18 {
  if (tariffPerNight.currency !== "INR") throw new CurrencyMismatchError("INR", tariffPerNight.currency);
  if (!Number.isSafeInteger(tariffPerNight.minor) || tariffPerNight.minor < 0) {
    throw new RangeError(`A tariff must be a non-negative amount, received ${String(tariffPerNight.minor)}`);
  }
  return tariffPerNight.minor <= FIVE_PERCENT_SLAB_MAX_MINOR ? 5 : 18;
}

/** Slab, tax per night rounded to whole rupees half-to-even, and tax = taxPerNight × nights. */
export function gstForStay(
  tariffPerNight: Money,
  nights: number,
): { ratePercent: 0 | 5 | 18; taxPerNight: Money; tax: Money } {
  if (!Number.isInteger(nights) || nights < 1) {
    throw new RangeError(`A stay must be at least one night, received ${String(nights)}`);
  }
  const ratePercent = gstRatePercentForTariff(tariffPerNight);
  // paise × percent ÷ 100 = tax in paise; ÷ a further 100 = rupees. One division, one rounding.
  const rupees = divRoundHalfEven(tariffPerNight.minor * ratePercent, 10_000);
  const taxPerNight = money(rupees * 100, "INR");
  return { ratePercent, taxPerNight, tax: multiplyMoney(taxPerNight, nights) };
}

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th GSTIN character for the first 14, by the mod-36 check-digit algorithm. */
export function gstinCheckDigit(first14: string): string {
  const input = first14.toUpperCase();
  if (!/^[0-9A-Z]{14}$/.test(input)) {
    throw new RangeError(`Expected 14 GSTIN characters (0-9, A-Z), received "${first14}"`);
  }
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = BASE36.indexOf(input.charAt(i));
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return BASE36.charAt((36 - (total % 36)) % 36);
}

// State code · 5 PAN letters · 4 PAN digits · PAN check letter · entity number
// (1-9, A-Z) · reserved (normally "Z") · check digit.
const GSTIN_SHAPE = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z][0-9A-Z][0-9A-Z]$/;

/**
 * True for a regular-taxpayer GSTIN with a known state code and a correct check
 * digit. Case-sensitive: a lowercase GSTIN would print wrongly on a tax invoice.
 */
export function isValidGstin(gstin: string): boolean {
  if (typeof gstin !== "string") return false;
  const match = GSTIN_SHAPE.exec(gstin);
  if (match === null) return false;
  const state = match[1];
  if (state === undefined || GST_STATE_NAMES[state] === undefined) return false;
  return gstinCheckDigit(gstin.slice(0, 14)) === gstin.charAt(14);
}

const IST_OFFSET_MS = 330 * 60_000;

/**
 * The Indian financial year (April–March) of a date or instant, as "2026-27". An
 * instant is read in Asia/Kolkata, which has a fixed +05:30 offset and no DST —
 * so 31 Mar 2027 20:00 UTC is already FY 2027-28.
 */
export function financialYearOf(at: IsoDate | IsoDateTime): string {
  let year: number;
  let month: number;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
  if (dateOnly !== null) {
    year = Number(dateOnly[1]);
    month = Number(dateOnly[2]);
  } else {
    const stamp = Date.parse(at);
    if (Number.isNaN(stamp)) throw new RangeError(`Expected an ISO date or date-time, received "${at}"`);
    const ist = new Date(stamp + IST_OFFSET_MS);
    year = ist.getUTCFullYear();
    month = ist.getUTCMonth() + 1;
  }
  if (month < 1 || month > 12) throw new RangeError(`"${at}" has no valid month`);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * "ACME/2627/000123": prefix, compact financial year, and a six-digit sequence.
 * Throws InvoiceNumberTooLongError above 16 characters, and RangeError for any
 * character Rule 46 does not allow.
 */
export function invoiceNumber(prefix: string, financialYear: string, sequence: number): string {
  const fy = /^(\d{4})-(\d{2})$/.exec(financialYear);
  if (fy === null || fy[1] === undefined || fy[2] === undefined) {
    throw new RangeError(`Expected a financial year like "2026-27", received "${financialYear}"`);
  }
  if ((Number(fy[1]) + 1) % 100 !== Number(fy[2])) {
    throw new RangeError(`"${financialYear}" is not a consecutive April–March year`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`An invoice sequence starts at 1, received ${String(sequence)}`);
  }
  const number = `${prefix}/${fy[1].slice(2)}${fy[2]}/${String(sequence).padStart(6, "0")}`;
  if (!/^[A-Za-z0-9/-]+$/.test(number)) {
    throw new RangeError(`Invoice number "${number}" may contain only letters, digits, "-" and "/"`);
  }
  if (number.length > 16) throw new InvoiceNumberTooLongError(number);
  return number;
}

function stateName(code: string | null): string {
  if (code === null) return "the hotel's state";
  return GST_STATE_NAMES[code] ?? `state ${code}`;
}

function nightsPhrase(nights: number): string {
  return `${nights} ${nights === 1 ? "night" : "nights"}`;
}

/** The label's "(20%)" as a number, for display only; 0 when the label names no rate. */
function percentInLabel(label: string): number {
  const match = /\((\d+(?:\.\d+)?)%\)/.exec(label);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/**
 * A GST tax invoice for an Indian property priced in INR (hotel as supplier,
 * entity as recipient, place of supply = the property's state, CGST + SGST), or
 * an itemised tax summary anywhere else. Lines reconcile exactly to allInTotal.
 */
export function buildInvoice(args: {
  id: string;
  booking: Booking;
  entity: LegalEntity;
  number: string;
  financialYear: string;
  issuedAt: IsoDateTime;
}): Invoice {
  const { id, booking, entity, number, financialYear, issuedAt } = args;
  const { property, rate } = booking.offer;
  assertComponentsSum(rate);
  const currency = rate.currency;

  const supplier: InvoiceParty = {
    name: property.name,
    gstin: property.supplierGstin,
    stateCode: property.stateCode,
    address: property.addressLine,
  };
  const recipient: InvoiceParty = {
    name: entity.legalName,
    gstin: entity.gstin,
    stateCode: entity.stateCode,
    address: entity.address,
  };

  if (property.countryCode === "IN" && currency === "INR") {
    const slab = gstForStay(rate.tariffPerNight, rate.nights);
    const charged = sumMoney(
      rate.components.filter((c) => c.kind === "tax").map((c) => c.amount),
      currency,
    );
    // The invoice states what was charged. If the rate's GST disagrees with the
    // slab, issuing a document that silently differs from the charge is worse
    // than issuing none: refuse, loudly.
    if (charged.minor !== slab.tax.minor) {
      throw new PricingIntegrityError(
        `Rate ${rate.id}: GST charged is ${formatMoney(charged, { decimals: true })} but the ${slab.ratePercent}% slab gives ${formatMoney(slab.tax, { decimals: true })}`,
      );
    }

    const tax = slab.tax;
    const taxable = subMoney(rate.allInTotal, tax);
    // Accommodation is intra-state for the hotel. The split is in paise, so an odd
    // tax gives CGST one paisa less than SGST and the halves still sum to the tax.
    const cgst = money(Math.floor(tax.minor / 2), currency);
    const sgst = subMoney(tax, cgst);

    const line: InvoiceLine = {
      description: `Room accommodation · ${nightsPhrase(rate.nights)} · ${formatDateRange(rate.checkIn, rate.checkOut)}`,
      sac: SAC_ACCOMMODATION,
      taxableValue: taxable,
      taxRatePercent: slab.ratePercent,
      cgst,
      sgst,
      igst: null,
      otherTax: null,
      total: rate.allInTotal,
    };

    const hotelState = stateName(property.stateCode);
    let itc: Invoice["itc"];
    if (slab.ratePercent !== 18) {
      itc = { claimable: false, reason: "The 5% slab carries no input tax credit" };
    } else if (entity.gstin === null) {
      itc = {
        claimable: false,
        reason: `Charged as ${hotelState} CGST + SGST — your entity has no GSTIN on file, so this credit can't be claimed`,
      };
    } else if (entity.stateCode !== null && entity.stateCode === property.stateCode) {
      itc = { claimable: true, reason: `Charged as ${hotelState} CGST + SGST to your ${hotelState} GSTIN` };
    } else {
      itc = {
        claimable: false,
        reason: `Charged as ${hotelState} CGST + SGST — your GSTIN is registered in ${stateName(entity.stateCode)}, so this credit can't be claimed there`,
      };
    }

    return {
      id,
      bookingId: booking.id,
      entityId: booking.entityId,
      kind: "gst_tax_invoice",
      number,
      financialYear,
      issuedAt,
      supplier,
      recipient,
      placeOfSupply: property.stateCode,
      lines: [line],
      taxableTotal: taxable,
      taxTotal: tax,
      grandTotal: rate.allInTotal,
      itc,
    };
  }

  // Anywhere else: an itemised summary. Every non-base component — VAT, a
  // municipality fee, a service charge — is its own line, so the lines add to the total.
  const zero = money(0, currency);
  const lines: InvoiceLine[] = rate.components.map((component) =>
    component.kind === "base"
      ? {
          description: component.label,
          sac: null,
          taxableValue: component.amount,
          taxRatePercent: 0,
          cgst: null,
          sgst: null,
          igst: null,
          otherTax: null,
          total: component.amount,
        }
      : {
          description: component.label,
          sac: null,
          taxableValue: zero,
          taxRatePercent: percentInLabel(component.label),
          cgst: null,
          sgst: null,
          igst: null,
          otherTax: component.amount,
          total: component.amount,
        },
  );

  return {
    id,
    bookingId: booking.id,
    entityId: booking.entityId,
    kind: "tax_summary",
    number,
    financialYear,
    issuedAt,
    supplier,
    recipient,
    placeOfSupply: null,
    lines,
    taxableTotal: sumMoney(
      rate.components.filter((c) => c.kind === "base").map((c) => c.amount),
      currency,
    ),
    taxTotal: sumMoney(
      rate.components.filter((c) => c.kind !== "base").map((c) => c.amount),
      currency,
    ),
    grandTotal: rate.allInTotal,
    itc: { claimable: false, reason: "This is a tax summary, not a GST document" },
  };
}
