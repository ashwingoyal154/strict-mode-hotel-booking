/**
 * Deterministic fixture pricing. `ratesFor(property, query, sourceId)` must
 * return byte-identical output for identical inputs forever (see
 * tests/unit/supply-fixtures.test.ts) — no `Math.random()` anywhere in this
 * file. All randomness is a small seeded PRNG keyed off a string hash of
 * (property.id, checkIn, sourceId).
 *
 * Every component sums exactly to allInTotal: the total is built FROM the
 * components (base + GST + optional service fee), never the other way round.
 * Integer minor units (paise) only.
 */
import type { Rate, RateComponent, Property, SearchQuery, SupplyChannel } from "../../core/types.ts";
import { money } from "../../core/money.ts";
import { nightsBetween } from "../../core/commute.ts";
import { DRIFT_MARKER_SUFFIX, SOLD_OUT_MARKER_SUFFIX } from "./adversarial.ts";

const CURRENCY = "INR";
const GST_RATE = 0.12;
const SERVICE_FEE_RATE = 0.025;

/** FNV-1a, 32-bit. Only used to seed the PRNG below — never for anything else. */
function hashString(input: string): number {
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

/** Base per-night range (minor units, INR) before tax/fees, by policy tier. */
function basePerNightRangeMinor(cityTier: string): readonly [number, number] {
  if (cityTier === "metro") return [420_000, 1_150_000]; // ₹4,200 – ₹11,500
  if (cityTier === "tier2") return [250_000, 650_000]; // ₹2,500 – ₹6,500
  return [320_000, 920_000]; // tier1: ₹3,200 – ₹9,200
}

/** Fixed per-source business-channel mapping — see FixtureRateSource.ts. */
const SOURCE_CHANNEL: Readonly<Record<string, SupplyChannel>> = {
  "fx-alpha": "negotiated",
  "fx-beta": "public",
  "fx-gamma": "bedbank",
  "fx-delta": "public",
};

function channelFor(sourceId: string): SupplyChannel {
  return SOURCE_CHANNEL[sourceId] ?? "public";
}

function roundToRupee(minor: number): number {
  return Math.round(minor / 100) * 100;
}

/** "2026-06-11" + N days at noon UTC, as an IsoDateTime. */
function isoAtNoonOffsetDays(isoDate: string, offsetDays: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

/**
 * Components for a whole stay, built up from WHOLE-RUPEE per-night figures.
 *
 * Tax and fee are rounded per night and then multiplied by nights, not computed
 * over the stay and rounded once. Doing it the other way leaves an all-in total
 * that is not divisible by nights, and the product then quotes a business
 * traveller "₹6,581.46/night" — a number no Indian hotel has ever charged. The
 * per-night figure is the one on every card, so it has to be real money.
 */
function buildComponents(
  basePerNightMinor: number,
  nights: number,
  includeFee: boolean,
): {
  components: RateComponent[];
  allInTotalMinor: number;
  perNightMinor: number;
} {
  const gstPerNightMinor = roundToRupee(basePerNightMinor * GST_RATE);
  const feePerNightMinor = includeFee ? roundToRupee(basePerNightMinor * SERVICE_FEE_RATE) : 0;

  const components: RateComponent[] = [
    { kind: "base", label: "Room charge", amount: money(basePerNightMinor * nights, CURRENCY) },
    { kind: "tax", label: "GST (12%)", amount: money(gstPerNightMinor * nights, CURRENCY) },
  ];
  if (feePerNightMinor > 0) {
    components.push({
      kind: "fee",
      label: "Service fee",
      amount: money(feePerNightMinor * nights, CURRENCY),
    });
  }

  // The total is the sum of the components above — never computed independently.
  const allInTotalMinor = components.reduce((sum, c) => sum + c.amount.minor, 0);
  // Exact by construction: every component is a whole-rupee per-night figure × nights.
  const perNightMinor = basePerNightMinor + gstPerNightMinor + feePerNightMinor;
  return { components, allInTotalMinor, perNightMinor };
}

const RATE_PLAN_SUFFIXES = ["Standard Room", "Deluxe Room"] as const;

/**
 * Deterministic rates for one property/search/source. 1–2 rates, exact
 * component sums, ~35% non-refundable, breakfast and service fee vary by a
 * seeded coin flip so a single policy cap yields a realistic in/over-cap mix.
 */
export function ratesFor(property: Property, query: SearchQuery, sourceId: string): Rate[] {
  const nights = Math.max(1, nightsBetween(query.checkIn, query.checkOut));
  const seed = hashString(`${property.id}|${query.checkIn}|${sourceId}`);
  const rand = mulberry32(seed);

  const [rangeMin, rangeMax] = basePerNightRangeMinor(property.cityTier);
  const basePerNightMinor = roundToRupee(rangeMin + Math.floor(rand() * (rangeMax - rangeMin + 1)));

  const numRates = rand() < 0.35 ? 2 : 1;
  const channel = channelFor(sourceId);
  const rates: Rate[] = [];

  for (let r = 0; r < numRates; r++) {
    // Second rate plan (if any) is a step up in room category.
    const planBaseMinor = r === 0 ? basePerNightMinor : roundToRupee(basePerNightMinor * 1.22);

    const includeFee = rand() < 0.5;
    const { components, allInTotalMinor, perNightMinor } = buildComponents(
      planBaseMinor,
      nights,
      includeFee,
    );

    const nonRefundable = rand() < 0.35;
    const refundableUntil = nonRefundable ? null : isoAtNoonOffsetDays(query.checkIn, -1);
    const breakfastIncluded = rand() < 0.5;

    let id = `${property.id}~${sourceId}~${query.checkIn}~r${r}`;
    if (property.id === "prop-bkc-canary-drift" && r === 0) {
      id = `${id}${DRIFT_MARKER_SUFFIX}`;
    } else if (property.id === "prop-bkc-canary-soldout" && r === 0) {
      id = `${id}${SOLD_OUT_MARKER_SUFFIX}`;
    }

    rates.push({
      id,
      propertyId: property.id,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights,
      currency: CURRENCY,
      components,
      allInTotal: money(allInTotalMinor, CURRENCY),
      perNight: money(perNightMinor, CURRENCY),
      breakfastIncluded,
      refundableUntil,
      channel,
      supplierRef: `sup-${property.id}-${sourceId}-${r}-${RATE_PLAN_SUFFIXES[r] ?? "Room"}`,
      sourceId,
    });
  }

  return rates;
}
