/**
 * Fixture supply: exactly four sources with distinct latencies and
 * overlapping-but-different property subsets, so the UI's streaming "N of 4
 * sources" meter has real behaviour to show (SPEC.md §3.1 — fan out in
 * parallel, stream results, never block on the slowest).
 *
 * Slice 2 adds holds. Two of the four sources can hold a rate while an approval
 * is pending; the other two cannot, so the "never claim a hold that does not
 * exist" path is exercised by ordinary searches, not only by tests.
 *
 * Holds are stateless: a holdRef carries the offer, source, held total and expiry
 * inside itself. Production runs on serverless, where the instance that took the
 * hold is rarely the instance that books against it. A fixture has no inventory
 * to protect, so the ref is encoded rather than signed; a live supplier's ref is
 * opaque and enforced on its side.
 *
 * No booking, policy, billing or UI code may know this is a fixture — it only
 * ever sees the RateSource interface.
 */
import { randomUUID } from "node:crypto";
import type { IsoDateTime, Money, Offer, OfferId, Property, Rate, SearchQuery } from "../core/types.ts";
import type {
  RateSource,
  RateSourceCapabilities,
  SupplierBookRequest,
  SupplierBooking,
  SupplierHold,
  SupplierHoldRequest,
} from "./RateSource.ts";
import {
  SupplierHoldExpiredError,
  SupplierHoldUnsupportedError,
  SupplierPriceDriftError,
  SupplierSoldOutError,
} from "./RateSource.ts";
import { CANARY_PROPERTY_IDS, FIXTURE_PROPERTIES, propertiesNear } from "./fixtures/properties.ts";
import { FIXTURE_HOLD_MINUTES, driftedRate, hashString, ratesFor } from "./fixtures/rates.ts";
import {
  DRIFT_MARKER_SUFFIX,
  LATE_DRIFT_MARKER_SUFFIX,
  SOLD_OUT_MARKER_SUFFIX,
  defaultChaos,
  type ChaosConfig,
} from "./fixtures/adversarial.ts";

const SEARCH_RADIUS_METERS = 20_000; // covers the 200m–14km fixture spread

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

const HOLD_REF_PREFIX = "fxhold.";

const propertyById = new Map(FIXTURE_PROPERTIES.map((p) => [p.id, p]));
const canaryIds = new Set<string>(Object.values(CANARY_PROPERTY_IDS));

/** Canaries are always visible everywhere; other properties are ~70% per source. */
function includedInSource(propertyId: string, sourceId: string): boolean {
  if (canaryIds.has(propertyId)) return true;
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

/** Drifts at price check AND at book. */
function isDrifted(offerId: OfferId, chaos: ChaosConfig): boolean {
  return offerId.endsWith(DRIFT_MARKER_SUFFIX) || (chaos.enabled && chaos.driftOfferIds.includes(offerId));
}

/** Stable at price check, drifts only when booked without a hold. */
function isLateDrifted(offerId: OfferId): boolean {
  return offerId.endsWith(LATE_DRIFT_MARKER_SUFFIX);
}

function propertyIdFromOfferId(offerId: OfferId): string {
  return offerId.split("~")[0] ?? offerId;
}

function findRate(offerId: OfferId, query: SearchQuery, sourceId: string): { property: Property; rate: Rate } | null {
  const property = propertyById.get(propertyIdFromOfferId(offerId));
  if (!property) return null;
  const rate = ratesFor(property, query, sourceId).find((r) => r.id === offerId);
  if (!rate) return null;
  return { property, rate };
}

interface HoldClaims {
  readonly offerId: OfferId;
  readonly sourceId: string;
  readonly heldTotal: Money;
  readonly heldUntil: IsoDateTime;
}

function encodeHold(claims: HoldClaims): string {
  return HOLD_REF_PREFIX + Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function decodeHold(ref: string): HoldClaims | null {
  if (!ref.startsWith(HOLD_REF_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ref.slice(HOLD_REF_PREFIX.length), "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const c = parsed as Partial<HoldClaims>;
    if (
      typeof c.offerId !== "string" ||
      typeof c.sourceId !== "string" ||
      typeof c.heldUntil !== "string" ||
      typeof c.heldTotal?.minor !== "number" ||
      typeof c.heldTotal.currency !== "string"
    ) {
      return null;
    }
    return { offerId: c.offerId, sourceId: c.sourceId, heldTotal: c.heldTotal, heldUntil: c.heldUntil };
  } catch {
    return null;
  }
}

function makeSource(spec: SourceSpec, chaos: ChaosConfig, now: () => Date): RateSource {
  const maxHoldMinutes = FIXTURE_HOLD_MINUTES[spec.id] ?? 0;
  const capabilities: RateSourceCapabilities = {
    holds: maxHoldMinutes > 0,
    maxHoldMinutes,
    live: false,
    currencies: "any",
  };

  /** The authoritative current offer, applying the drift canaries that bite at price check. */
  function current(offerId: OfferId, query: SearchQuery): Offer | null {
    const found = findRate(offerId, query, spec.id);
    if (!found || isSoldOut(offerId, chaos)) return null;
    if (isDrifted(offerId, chaos)) return { property: found.property, rate: driftedRate(found.rate, found.property) };
    return found;
  }

  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities,

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
      return current(offerId, query);
    },

    async hold(req: SupplierHoldRequest): Promise<SupplierHold> {
      if (!capabilities.holds) throw new SupplierHoldUnsupportedError(`${spec.displayName} cannot hold rates`);
      const offer = current(req.offerId, req.query);
      if (offer === null) throw new SupplierSoldOutError();
      if (!offer.rate.holdable) throw new SupplierHoldUnsupportedError("this rate cannot be held");

      const minutes = Math.max(1, Math.min(req.minutes, maxHoldMinutes));
      const heldUntil = new Date(now().getTime() + minutes * 60_000).toISOString();
      const heldTotal = offer.rate.allInTotal;
      return {
        holdRef: encodeHold({ offerId: req.offerId, sourceId: spec.id, heldTotal, heldUntil }),
        heldTotal,
        heldUntil,
      };
    },

    async releaseHold(_holdRef: string): Promise<void> {
      // Stateless holds lapse on their own; there is nothing to release supplier-side.
    },

    async book(req: SupplierBookRequest): Promise<SupplierBooking> {
      const found = findRate(req.offerId, req.query, spec.id);
      if (!found) throw new SupplierSoldOutError();

      if (req.holdRef !== null) {
        const claims = decodeHold(req.holdRef);
        if (
          claims === null ||
          claims.offerId !== req.offerId ||
          claims.sourceId !== spec.id ||
          now().getTime() > Date.parse(claims.heldUntil)
        ) {
          throw new SupplierHoldExpiredError(req.holdRef);
        }
        // A valid hold is a price guarantee: it beats every drift canary.
        return {
          supplierBookingRef: `sbk_${randomUUID()}`,
          confirmedTotal: claims.heldTotal,
          cancellationDeadline: found.rate.refundableUntil,
          checkInTime: "14:00",
        };
      }

      if (isSoldOut(req.offerId, chaos)) throw new SupplierSoldOutError();
      if (isDrifted(req.offerId, chaos) || isLateDrifted(req.offerId)) {
        const drifted = driftedRate(found.rate, found.property);
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

/** Exactly four fixture sources — see SOURCE_SPECS for ids, names and latencies. */
export function createFixtureRateSources(opts?: { chaos?: ChaosConfig; now?: () => Date }): RateSource[] {
  const chaos = opts?.chaos ?? defaultChaos();
  const now = opts?.now ?? (() => new Date());
  return SOURCE_SPECS.map((spec) => makeSource(spec, chaos, now));
}
