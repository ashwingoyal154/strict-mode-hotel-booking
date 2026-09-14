/**
 * Deterministic fixture pricing. `ratesFor(property, query, sourceId)` must
 * return byte-identical output for identical inputs forever (see
 * tests/unit/supply-fixtures.test.ts) — no `Math.random()` anywhere in this
 * file. All randomness is a small seeded PRNG keyed off a string hash of
 * (property.id, checkIn, sourceId).
 *
 * Slice 2 pricing rules:
 *  - Every rate carries `tariffPerNight`, the pre-tax room tariff per night.
 *  - India is priced in INR with EXACTLY two components: "Room charge" and
 *    "GST (5%)" / "GST (18%)" from core `gstForStay` (GST 2.0 slabs, effective
 *    22 Sep 2025 — the old 12% slab no longer exists). No service fee, so the
 *    hotel's GST tax invoice reconciles to the rupee.
 *  - Abroad, rates are in local currency with local lines: GB VAT 20%; AE VAT
 *    5% plus a 7% municipality fee; SG a 10% service charge plus 9% GST on
 *    base + service charge.
 *  - Every component is a whole-unit per-night figure × nights, so components
 *    sum to allInTotal exactly and `perNight × nights === allInTotal`. Nobody
 *    has ever been quoted "₹6,581.46/night" by a hotel.
 */
import type { Currency, Money, Property, Rate, RateComponent, SearchQuery, SupplyChannel } from "../../core/types.ts";
import { money } from "../../core/money.ts";
import { nightsBetween } from "../../core/commute.ts";
import { gstForStay } from "../../core/gst.ts";
import { DRIFT_MARKER_SUFFIX, LATE_DRIFT_MARKER_SUFFIX, SOLD_OUT_MARKER_SUFFIX } from "./adversarial.ts";
import { CANARY_PROPERTY_IDS } from "./properties.ts";

/** FNV-1a, 32-bit. Only used to seed the PRNG below — never for anything else. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic for a given 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- markets ----------

type TaxRegime = "IN_GST" | "GB_VAT" | "AE_VAT_MUNI" | "SG_SC_GST";

interface Market {
  readonly currency: Currency;
  readonly regime: TaxRegime;
  /** Tariff per night range in MAJOR units, inclusive, and its rounding step. */
  readonly tariffRange: readonly [number, number];
  readonly tariffStep: number;
}

const MINOR_PER_UNIT = 100; // INR, GBP, AED, SGD all have two decimal places.

/**
 * Tariff ranges are set against the seeded caps so every city shows `in`,
 * `over` and — with requireFlexible or a blocked supplier — `blocked` rates:
 *  - metro cap ₹9,000 all-in: in while tariff ≤ ₹7,627 (18% above ₹7,500)
 *  - tier1 cap ₹7,000 all-in: in while tariff ≤ ₹6,666
 *  - Singapore SGD 450, Dubai AED 1,400, London ₹45,000 via the GBP pin (~£420)
 */
function marketFor(property: Property): Market {
  switch (property.countryCode) {
    case "GB":
      return { currency: "GBP", regime: "GB_VAT", tariffRange: [240, 520], tariffStep: 5 };
    case "AE":
      return { currency: "AED", regime: "AE_VAT_MUNI", tariffRange: [850, 1700], tariffStep: 50 };
    case "SG":
      return { currency: "SGD", regime: "SG_SC_GST", tariffRange: [260, 520], tariffStep: 10 };
    default:
      if (property.cityTier === "metro") {
        return { currency: "INR", regime: "IN_GST", tariffRange: [4500, 11500], tariffStep: 50 };
      }
      if (property.cityTier === "tier2") {
        return { currency: "INR", regime: "IN_GST", tariffRange: [2000, 6000], tariffStep: 50 };
      }
      return { currency: "INR", regime: "IN_GST", tariffRange: [3000, 9000], tariffStep: 50 };
  }
}

/** Fixed per-source business-channel mapping — see FixtureRateSource.ts. */
const SOURCE_CHANNEL: Readonly<Record<string, SupplyChannel>> = {
  "fx-alpha": "negotiated",
  "fx-beta": "public",
  "fx-gamma": "bedbank",
  "fx-delta": "public",
};

/** Sources that can hold rates, and for how long. fx-beta and fx-delta cannot. */
export const FIXTURE_HOLD_MINUTES: Readonly<Record<string, number>> = {
  "fx-alpha": 240,
  "fx-gamma": 120,
};

function channelFor(sourceId: string): SupplyChannel {
  return SOURCE_CHANNEL[sourceId] ?? "public";
}

/** "2026-06-11" + N days at noon UTC, as an IsoDateTime. */
function isoAtNoonOffsetDays(isoDate: string, offsetDays: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

/** `pct`% of `basisMinor`, rounded half-up to a whole currency unit, integers only. */
function percentWholeUnits(basisMinor: number, pct: number): number {
  const unitsTimes100 = basisMinor * pct; // = units × 100 × 100
  return Math.floor((unitsTimes100 + 50 * MINOR_PER_UNIT) / (100 * MINOR_PER_UNIT)) * MINOR_PER_UNIT;
}

interface Pricing {
  readonly components: RateComponent[];
  readonly allInTotal: Money;
  readonly perNight: Money;
  readonly tariffPerNight: Money;
}

/**
 * Builds the component list for a whole stay from ONE per-night tariff. Each
 * per-night line is a whole currency unit, multiplied by nights; the total is
 * the sum of the lines, never computed independently.
 */
function buildPricing(market: Market, tariffMinor: number, nights: number): Pricing {
  const c = market.currency;
  const perNightLines: Array<{ kind: RateComponent["kind"]; label: string; minor: number }> = [];

  switch (market.regime) {
    case "IN_GST": {
      const gst = gstForStay(money(tariffMinor, c), 1);
      perNightLines.push({ kind: "base", label: "Room charge", minor: tariffMinor });
      perNightLines.push({ kind: "tax", label: `GST (${gst.ratePercent}%)`, minor: gst.taxPerNight.minor });
      break;
    }
    case "GB_VAT":
      perNightLines.push({ kind: "base", label: "Room charge", minor: tariffMinor });
      perNightLines.push({ kind: "tax", label: "VAT (20%)", minor: percentWholeUnits(tariffMinor, 20) });
      break;
    case "AE_VAT_MUNI":
      perNightLines.push({ kind: "base", label: "Room charge", minor: tariffMinor });
      perNightLines.push({ kind: "tax", label: "VAT (5%)", minor: percentWholeUnits(tariffMinor, 5) });
      perNightLines.push({ kind: "fee", label: "Municipality fee (7%)", minor: percentWholeUnits(tariffMinor, 7) });
      break;
    case "SG_SC_GST": {
      const serviceCharge = percentWholeUnits(tariffMinor, 10);
      perNightLines.push({ kind: "base", label: "Room charge", minor: tariffMinor });
      perNightLines.push({ kind: "fee", label: "Service charge (10%)", minor: serviceCharge });
      perNightLines.push({ kind: "tax", label: "GST (9%)", minor: percentWholeUnits(tariffMinor + serviceCharge, 9) });
      break;
    }
  }

  // India: the stay tax comes from gstForStay over the whole stay, which is
  // defined as taxPerNight × nights — identical to the per-night line × nights.
  const components: RateComponent[] = perNightLines.map((l) => ({
    kind: l.kind,
    label: l.label,
    amount: money(l.minor * nights, c),
  }));
  if (market.regime === "IN_GST") {
    const stay = gstForStay(money(tariffMinor, c), nights);
    const tax = components[1];
    if (tax) components[1] = { ...tax, amount: stay.tax };
  }

  const allInTotalMinor = components.reduce((sum, x) => sum + x.amount.minor, 0);
  const perNightMinor = perNightLines.reduce((sum, l) => sum + l.minor, 0);
  return {
    components,
    allInTotal: money(allInTotalMinor, c),
    perNight: money(perNightMinor, c),
    tariffPerNight: money(tariffMinor, c),
  };
}

function roundToStepMinor(majorUnits: number, step: number): number {
  return Math.round(majorUnits / step) * step * MINOR_PER_UNIT;
}

/** Forced tariff for the late-drift canary: ₹10,400 + 18% = ₹12,272/night, over every seeded cap. */
const LATE_DRIFT_TARIFF_MINOR = 1_040_000;

const RATE_PLAN_SUFFIXES = ["Standard Room", "Deluxe Room"] as const;

/**
 * Deterministic rates for one property/search/source. 1–2 rates, exact
 * component sums, ~35% non-refundable, breakfast varying by a seeded coin flip.
 * Rates from hold-capable sources are ~70% holdable, decided by a separate hash
 * of the rate id so holdability never perturbs the price sequence.
 */
export function ratesFor(property: Property, query: SearchQuery, sourceId: string): Rate[] {
  const nights = Math.max(1, nightsBetween(query.checkIn, query.checkOut));
  const rand = mulberry32(hashString(`${property.id}|${query.checkIn}|${sourceId}`));
  const market = marketFor(property);

  const [lo, hi] = market.tariffRange;
  const rawTariff = lo + Math.floor(rand() * (hi - lo + 1));
  const baseTariffMinor = roundToStepMinor(rawTariff, market.tariffStep);

  // The late-drift canary carries exactly one rate. Dedupe keeps one row per hotel
  // and prefers the cheaper plan, so a second plan would hide the canary from every
  // results page it exists to appear on. The draw is still taken, so the price
  // sequence of every other property is unchanged.
  const planDraw = rand();
  const numRates = property.id === CANARY_PROPERTY_IDS.lateDrift ? 1 : planDraw < 0.35 ? 2 : 1;
  const channel = channelFor(sourceId);
  const sourceHolds = sourceId in FIXTURE_HOLD_MINUTES;
  const rates: Rate[] = [];

  for (let r = 0; r < numRates; r++) {
    // Second rate plan (if any) is a step up in room category.
    let tariffMinor =
      r === 0 ? baseTariffMinor : roundToStepMinor((baseTariffMinor / MINOR_PER_UNIT) * 1.22, market.tariffStep);

    const nonRefundable = rand() < 0.35;
    const breakfastIncluded = rand() < 0.5;

    let id = `${property.id}~${sourceId}~${query.checkIn}~r${r}`;
    let holdable = sourceHolds && hashString(`${id}|hold`) % 100 < 70;
    if (r === 0 && property.id === CANARY_PROPERTY_IDS.drift) {
      id = `${id}${DRIFT_MARKER_SUFFIX}`;
      holdable = sourceHolds; // addressable: "a valid hold beats drift"
    } else if (r === 0 && property.id === CANARY_PROPERTY_IDS.soldOut) {
      id = `${id}${SOLD_OUT_MARKER_SUFFIX}`;
    } else if (r === 0 && property.id === CANARY_PROPERTY_IDS.lateDrift) {
      id = `${id}${LATE_DRIFT_MARKER_SUFFIX}`;
      tariffMinor = LATE_DRIFT_TARIFF_MINOR; // over cap, always
      holdable = false; // nothing protects it from moving
    }

    const pricing = buildPricing(market, tariffMinor, nights);

    rates.push({
      id,
      propertyId: property.id,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights,
      currency: market.currency,
      components: pricing.components,
      allInTotal: pricing.allInTotal,
      perNight: pricing.perNight,
      tariffPerNight: pricing.tariffPerNight,
      breakfastIncluded,
      refundableUntil: nonRefundable ? null : isoAtNoonOffsetDays(query.checkIn, -1),
      channel,
      supplierRef: `sup-${property.id}-${sourceId}-${r}-${RATE_PLAN_SUFFIXES[r] ?? "Room"}`,
      sourceId,
      holdable,
    });
  }

  return rates;
}

/**
 * The same rate re-priced ~8% higher (at least one tariff step), rebuilt with
 * the same market rules so components still sum and perNight stays exact.
 */
export function driftedRate(rate: Rate, property: Property): Rate {
  const market = marketFor(property);
  const stepMinor = market.tariffStep * MINOR_PER_UNIT;
  const bumped = roundToStepMinor((rate.tariffPerNight.minor / MINOR_PER_UNIT) * 1.08, market.tariffStep);
  const tariffMinor = Math.max(bumped, rate.tariffPerNight.minor + stepMinor);
  const pricing = buildPricing(market, tariffMinor, rate.nights);
  return {
    ...rate,
    components: pricing.components,
    allInTotal: pricing.allInTotal,
    perNight: pricing.perNight,
    tariffPerNight: pricing.tariffPerNight,
  };
}
