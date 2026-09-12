/**
 * Fixture supply: exactly four sources with distinct latencies and
 * overlapping-but-different property subsets, so the UI's streaming "N of 4
 * sources" meter has real behaviour to show (SPEC.md §3.1 — fan out in
 * parallel, stream results, never block on the slowest).
 *
 * No booking, policy, billing or UI code may know this is a fixture — it only
 * ever sees the RateSource interface.
 */
import { randomUUID } from "node:crypto";
import type { Offer, OfferId, Rate, RateComponent, SearchQuery } from "../core/types.ts";
import { money } from "../core/money.ts";
import type {
  RateSource,
  SupplierBookRequest,
  SupplierBooking,
} from "./RateSource.ts";
import { SupplierPriceDriftError, SupplierSoldOutError } from "./RateSource.ts";
import { FIXTURE_PROPERTIES, propertiesNear } from "./fixtures/properties.ts";
import { ratesFor } from "./fixtures/rates.ts";
import {
  DRIFT_MARKER_SUFFIX,
  SOLD_OUT_MARKER_SUFFIX,
  defaultChaos,
  type ChaosConfig,
} from "./fixtures/adversarial.ts";

const SEARCH_RADIUS_METERS = 20_000; // covers the 200m–14km fixture spread
const GST_RATE = 0.12;
const SERVICE_FEE_RATE = 0.025;

interface SourceSpec {
  readonly id: string;
  readonly displayName: string;
  readonly baseLatencyMs: number;
}

const SOURCE_SPECS: readonly SourceSpec[] = [
  { id: "fx-alpha", displayName: "Alpha Direct", baseLatencyMs: 120 },
  { id: "fx-beta", displayName: "Beta Aggregator", baseLatencyMs: 400 },
  { id: "fx-gamma", displayName: "Gamma Channel", baseLatencyMs: 900 },
  { id: "fx-delta", displayName: "Delta Bedbank", baseLatencyMs: 1800 },
];

/** A very long "never answers in time" delay for simulated timeouts. */
const TIMEOUT_HANG_MS = 30_000;

const propertyById = new Map(FIXTURE_PROPERTIES.map((p) => [p.id, p]));

function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Canaries are always visible everywhere; other properties are ~70% per source. */
function includedInSource(propertyId: string, sourceId: string): boolean {
  if (propertyId === "prop-bkc-canary-drift" || propertyId === "prop-bkc-canary-soldout") {
    return true;
  }
  return hashString(`${propertyId}|${sourceId}`) % 100 < 70;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** Resolves after `ms`, or rejects promptly if `signal` fires first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isSoldOut(offerId: OfferId, chaos: ChaosConfig): boolean {
  return offerId.endsWith(SOLD_OUT_MARKER_SUFFIX) || (chaos.enabled && chaos.soldOutOfferIds.includes(offerId));
}

function isDrifted(offerId: OfferId, chaos: ChaosConfig): boolean {
  return offerId.endsWith(DRIFT_MARKER_SUFFIX) || (chaos.enabled && chaos.driftOfferIds.includes(offerId));
}

/** Rebuilds a rate at a bumped base price; components still sum exactly. */
function applyDrift(rate: Rate): Rate {
  const baseComponent = rate.components.find((c) => c.kind === "base");
  const baseMinor = baseComponent ? baseComponent.amount.minor : rate.allInTotal.minor;
  const includeFee = rate.components.some((c) => c.kind === "fee");

  const newBaseMinor = Math.round(baseMinor * 1.08);
  const gstMinor = Math.round(newBaseMinor * GST_RATE);
  const feeMinor = includeFee ? Math.round(newBaseMinor * SERVICE_FEE_RATE) : 0;

  const components: RateComponent[] = [
    { kind: "base", label: "Room charge", amount: money(newBaseMinor, rate.currency) },
    { kind: "tax", label: "GST (12%)", amount: money(gstMinor, rate.currency) },
  ];
  if (feeMinor > 0) {
    components.push({ kind: "fee", label: "Service fee", amount: money(feeMinor, rate.currency) });
  }
  const allInTotalMinor = components.reduce((sum, c) => sum + c.amount.minor, 0);
  const perNightMinor = Math.floor(allInTotalMinor / rate.nights);

  return {
    ...rate,
    components,
    allInTotal: money(allInTotalMinor, rate.currency),
    perNight: money(perNightMinor, rate.currency),
  };
}

function propertyIdFromOfferId(offerId: OfferId): string {
  return offerId.split("~")[0] ?? offerId;
}

function findRate(offerId: OfferId, query: SearchQuery, sourceId: string): { property: (typeof FIXTURE_PROPERTIES)[number]; rate: Rate } | null {
  const property = propertyById.get(propertyIdFromOfferId(offerId));
  if (!property) return null;
  const rate = ratesFor(property, query, sourceId).find((r) => r.id === offerId);
  if (!rate) return null;
  return { property, rate };
}

function makeSource(spec: SourceSpec, chaos: ChaosConfig): RateSource {
  return {
    id: spec.id,
    displayName: spec.displayName,

    async searchAvailability(query: SearchQuery, signal: AbortSignal): Promise<Offer[]> {
      const timedOut = chaos.enabled && chaos.timeoutSourceIds.includes(spec.id);
      const overrideMs = chaos.enabled ? chaos.latencyMs[spec.id] : undefined;
      const latencyMs = timedOut ? TIMEOUT_HANG_MS : overrideMs ?? spec.baseLatencyMs;

      await delay(latencyMs, signal);

      const near = propertiesNear(query.anchor.geo, SEARCH_RADIUS_METERS).filter((p) =>
        includedInSource(p.id, spec.id),
      );

      const offers: Offer[] = [];
      for (const property of near) {
        for (const rate of ratesFor(property, query, spec.id)) {
          offers.push({ property, rate });
        }
      }
      return offers;
    },

    async priceCheck(offerId: OfferId, query: SearchQuery): Promise<Offer | null> {
      const found = findRate(offerId, query, spec.id);
      if (!found) return null;
      if (isSoldOut(offerId, chaos)) return null;
      if (isDrifted(offerId, chaos)) {
        return { property: found.property, rate: applyDrift(found.rate) };
      }
      return found;
    },

    async book(req: SupplierBookRequest): Promise<SupplierBooking> {
      const found = findRate(req.offerId, req.query, spec.id);
      if (!found || isSoldOut(req.offerId, chaos)) {
        throw new SupplierSoldOutError();
      }
      if (isDrifted(req.offerId, chaos)) {
        const drifted = applyDrift(found.rate);
        throw new SupplierPriceDriftError(drifted.allInTotal, req.authorisedTotal);
      }
      return {
        supplierBookingRef: `sbk_${randomUUID()}`,
        confirmedTotal: found.rate.allInTotal,
        cancellationDeadline: found.rate.refundableUntil,
        checkInTime: "14:00",
      };
    },

    async cancel(_supplierBookingRef: string): Promise<void> {
      // Fixture cancellation always succeeds; nothing to void supplier-side.
    },
  };
}

/** Exactly four fixture sources — see SOURCE_SPECS for ids/displayNames/latencies. */
export function createFixtureRateSources(opts?: { chaos?: ChaosConfig }): RateSource[] {
  const chaos = opts?.chaos ?? defaultChaos();
  return SOURCE_SPECS.map((spec) => makeSource(spec, chaos));
}
